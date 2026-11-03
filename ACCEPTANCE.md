# Acceptance record

## Re-verification — 2026-11-03 (current build, 97 tests)

Re-ran the live capability harness against the scratch instance (`http://127.0.0.1:3096`, plugin
installed in `.dsh-test-home/profiles/web`, scratch profile default model switched by the harness to the
**text-only** route `deepseek-v4-flash`):

```
18/18 checks passed against http://127.0.0.1:3096
  PASS  media_probe reads duration and audio tracks
  PASS  media_probe reports video dimensions
  PASS  vision route receives a real image block
  PASS  vision route can read the image text
  PASS  text-only route returns an image description
  PASS  text-only description contains the image text
  PASS  text-only route did not receive an image block
  PASS  read_image is redirected to media_image
  PASS  audio is transcribed locally
  PASS  audio result names the local processor
  PASS  video digest answers the visual question
  PASS  video digest fuses the spoken transcript
  PASS  text-only video returns no image blocks
  PASS  silence is reported as no speech
  PASS  missing file fails explicitly
  PASS  drop upload describes an image
  PASS  drop upload transcribes audio
  PASS  drop upload digests video
```

Also on 2026-11-03: the **installed** copy's `media_evidence` tool (not the working tree) was run against a
real delivered film — `/home/samora/Music/essence of the Maasai.mp4`, 149.221 s, 1920x1080, 24 fps — and
returned a text pack reporting the source facts, **31 detected shots with a median 4.5 s shot**, the key
(C major, MEASURED), loudness (-12.8 LUFS), 537 onsets, an 8-segment chord map (INFERRED), three pilot
intervals, and an explicit list of what did not run (stems, MIDI, OCR, semantic pass) rather than
silently omitting it. Wall time 245 s, no generation call, no network.

Unit suite on this build: `npm test` → **97/97 pass**.

---

# Acceptance record — 2026-10-30

**Object:** `dsh-media-reader` at the working tree on branch `feat/media-reader`
**Harness:** DSH `0.1.1-rc.2`, scratch home `~/projects/Video_Image_Voice/.dsh-test-home`,
port `3096`; two sessions driven through the real `session.prompt`/`session.history` API.
**Models:** `deepseek-official/deepseek-v4-flash-vision-exp` (vision route) and
`deepseek-official/deepseek-v4-flash` (text-only route).
**STT:** local `faster-whisper 1.2.1` + `av 18.1.0`, `base`, int8, 4 threads.

> Every row below is a real DSH tool invocation on a real fixture, not a unit test.
> The unit suite (`npm test`, 38 tests) covers parsers, routing, locking and error shapes separately.

## Image

| # | Route | Input | Result |
|---|---|---|---|
| I1 | vision | `fixtures/hello.png` | **PASS.** `media_image` returned a real image block; the model answered “HELLO MEDIA” from the pixels. |
| I2 | text-only | `fixtures/hello.png` | **PASS.** `media_image` returned `<type>image-description</type>` from `deepseek-official/deepseek-v4-flash-vision-exp` with latency; text read “HELLO MEDIA”. |
| I3 | text-only | built-in `read_image` | **PASS as a redirect.** The pre-execute listener returned `Error: This model cannot consume image blocks … Call media_image …`. It is an error by design, not a fake success. |
| I4 | vision | missing file | **PASS.** `Error: NOT_FOUND: cannot read "…/missing.png": not found`. |
| I5 | vision | JPEG bytes named `.png` | **PASS.** `Error: IMAGE_TYPE_MISMATCH: … has an image extension but its bytes are a different format`. |
| I6 | vision | 4000×3000 PNG | **PASS.** Attachment store normalized to 2048×1536; envelope reported `(downscaled from 4000x3000 px)` and the image block was attached. |
| I7 | text-only, `visionFallback: off` | `hello.png` | **PASS.** `Error: VISION_FALLBACK_OFF: …` with no description and no vision call. |
| I8 | text-only, `autoRedirect: false` | `read_image` | **PASS (mutation).** The built-in refusal returned unchanged: `model "deepseek-v4-flash" does not declare image input`. This proves the redirect is what changes I3. |

## Audio

| # | Input | Result |
|---|---|---|
| A1 | real speech `fixtures/jfk.wav` (11 s) | **PASS.** `base` transcript: “And so my fellow Americans ask not what your country can do for you, ask what you can do for your country.” RTF 0.98. |
| A2 | video `fixtures/talking.mp4` | **PASS.** `media_audio` extracted the audio track and returned the same speech; visuals untouched. |
| A3 | silence `fixtures/silence.wav` | **PASS.** “no speech detected in 3.0 s … non-speech audio … out of scope”. Not an empty string. |
| A4 | non-speech tone (`sample.mp4`) | **PASS.** Video digest reported “no speech detected in the audio track”. |
| A5 | video with no audio (`silent.mp4`) | **PASS.** `Error: NO_AUDIO_TRACK: … has no audio track`. |
| A6 | STT runtime absent (before install) | **PASS.** `Error: STT_DEPENDENCY_MISSING: local speech-to-text is not installed: missing Python module: faster_whisper`. |
| A7 | `jfk.wav` with `maxSeconds=3` | **PASS.** Only the first 3.0 s processed; output carried `<truncated>only the first 3.0 seconds were processed</truncated>`. |

## Video

| # | Route/input | Result |
|---|---|---|
| V1 | vision, `talking.mp4`, digest | **PASS.** One contact-sheet image block attached; timeline fused the local transcript. |
| V2 | text-only, `error-demo.mp4`, question “What error number is shown?” | **PASS.** Contact sheet + two frame descriptions produced “ERROR 42”; the assistant answered **42** with the second-shot caveat. |
| V3 | vision, same question | **PASS.** The model answered **ERROR 42** from the attached contact sheet (no auxiliary description). |
| V4 | speech + visual together | **PASS.** Timeline carried both `said:` (JFK speech) and `on screen:` (ERROR 42) lines. |
| V5 | silent video, digest | **PASS.** Frames present; `said:` said “this file has no audio track”; transcript note said so. |
| V6 | static video, no cuts | **PASS.** Uniform sampling explicitly labelled `uniform; no scene cuts were detected`; unit tests cover the fallback. |
| V7 | text-only, digest | **PASS.** No image blocks returned; `<visual>` contained the vision-route description. |
| V8 | 20-minute video, T4 caps | **NOT VERIFIED.** No 20-minute fixture was processed; the caps exist in code/config but were not exercised end-to-end. |
| V9 | scene cuts, `multishot.mp4` | **PASS.** `scdet` found 3 shots; frames mode attached contact sheet + 3 frames (4 image blocks). |
| V10 | text-only, `mode=frames` | **PASS.** `Error: FRAMES_NEED_VISION: … use mode=digest on this text-only route`. |

## Measured STT (same 7.30 s clip, cached model, int8, 4 threads)

| Model | Wall time | RTF | Peak RSS |
|---|---|---|---|
| `base` | 8.40 s | 1.15× | 390 MB |
| `small` | 18.76 s | 2.57× | 791 MB |

`small` was initially measured at 251.79 s because the timer included its 480 MB download. That number
is **not** an RTF and is recorded here only to prevent it being reused as one. Default is `base`; `small`
is available for short clips where its slightly better handling of one hard word matters.

## Defects found during acceptance and fixed

1. **PyAV 19 removed `metadata_errors`**, which faster-whisper 1.2.1 still passes to `av.open`; every
   transcription failed. Pinned `av==18.1.0` in `python/requirements.txt`.
2. **A 700-token vision budget returned no text on a complex contact sheet** (reasoning consumed the
   cap). Raised `visionMaxTokens` to 2000; the same image then described correctly.
3. **ffprobe reported `fps: 25` for a still PNG**; still images now omit frame rate/frame count.
4. **An audio-only `.mp4` was labelled video by extension**; probe now reports `kind: audio` when ffprobe
   sees no video stream.
5. **HF Hub/onnxruntime logging polluted stdout**; the worker now emits a `MEDIA_READER_RESULT` marker and
   the bridge searches for it instead of parsing the whole stream.

## Drag-and-drop uploads

The composer client registers a **📎 Drop media** target and accepts drops anywhere in the composer.
The host route is `POST /media-reader/ingest` (loopback-only, client marker required, raw bytes).

| Input | Result |
|---|---|
| `hello.png` | **PASS.** `{ok:true, kind:"image"}` with the HELLO MEDIA description. |
| `jfk.wav` | **PASS.** `{ok:true, kind:"audio"}` with the JFK transcript. |
| `error-demo.mp4` | **PASS.** `{ok:true, kind:"video"}` with the timeline, JFK speech and ERROR 42 visual description. |
| missing `x-media-reader-client` | **PASS.** HTTP 403. |
| `notes.txt` | **PASS.** HTTP 415, `UNSUPPORTED_MEDIA`. |
| upload temp cleanup | **PASS.** `artifacts/uploads` empty after processing. |
| client bundle served | **PASS.** `GET /plugins/dsh-media-reader/client.js` → 200 and scratch boot clean. |

**Not visually verified:** the drop target's rendered position was not screenshotted — the sandboxed
browser did not render the page (Chrome timed out). The host route, bundle serving and boot are verified;
the operator must confirm the drop interaction in the UI.

## Native attachment gate vs drag-and-drop

The operator reported that dropping an **MP4** produced DSH's native
“Only PNG, JPG, WebP, and GIF images are supported” message. That is the host's
attachment gate, so the drop was not reaching the plugin client.

The client now installs `dragover`/`drop`/`paste` listeners on `window` in the
**capture phase** and calls `preventDefault()` + `stopPropagation()` before the
native handler. It accepts image/audio/video extensions by filename or MIME type,
so MP4, MOV, MKV, WebM, MP3, WAV, M4A and the rest are routed to the upload host.
The host route was already verified with `error-demo.mp4`; the change is about
which handler sees the drop first.

**Still not visually verified:** the drop target and the new window handler were
not screenshotted; the sandboxed browser timed out. If a drop still produces the
native PNG/JPG message, check the URL (the live 3080 does **not** have the plugin
until install/restart) and confirm the client bundle is loaded.

## Stuck native drag mask

A second drop defect: DSH's native **“Drag images here to add them”** mask appeared on `dragenter` and
stayed up after drop, because our capture-phase `drop` stopped the native `drop`/`dragend` reset. Fixed by
intercepting `dragenter` in the capture phase too, and dispatching `window.dispatchEvent(new DragEvent('dragend'))`
on drop as a fallback. The plugin's own status now shows **Analyzing …** / **Added … to the draft**
instead of leaving the native mask.

Not visually verified end-to-end: the sandboxed browser still cannot render the page, so the operator must
confirm the mask disappears after a drop.

## Not verified

- Live-profile installation and a real server restart (the scratch instance is on port 3096).
- A 20-minute video, a large real screen recording, and the video duration cap (V8).
- A real handset/audio device, microphone input, or streaming (out of scope).
- The `small` model on a long file; only the 7.30 s clip was measured.
- Publication: no npm package, licence, screenshot, leak-scan or pre-flight for release.
- A real client-facing review of the two scratch browser tabs.

## Reproduce the scratch instance

```bash
cd ~/projects/Video_Image_Voice
DSH_HOME=$PWD/.dsh-test-home dsh web --port 3096
# API: POST /api/session.create, then /api/session.prompt, then /api/session.history
```

The scratch home has its own profile and a symlinked `.credentials.yaml`; it never boots `~/.dsh`.

## Repeatable smoke harness

`probe/smoke.mjs` drives the same 15 acceptance checks through the live session API and passed
**18/18** against the scratch instance on port 3096 (session
`session-47b329d2-f9b1-4636-946d-be73707c49fb`). The final three checks drive the drag-and-drop host
route for image, audio and video uploads. It scopes every assertion to the turn it just ran;
its first version searched whole-session history and false-failed because it matched an earlier
vision-route image result. That was a harness bug, not a plugin bug — recorded here so the script is
not "simplified" back into the same mistake.

Run it with:

```bash
DSH_TEST_URL=http://127.0.0.1:3096 node probe/smoke.mjs
```
