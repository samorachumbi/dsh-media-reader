# dsh-media-reader

Read local **images, audio and video** from DeepSeek Harness — including on a
model route that cannot accept images.

Four tools, one redirect, and a composer drop target:

| Tool | What it does | Model calls |
|---|---|---|
| `media_probe` | ffprobe metadata: kind, duration, dimensions, fps, codecs, audio/subtitle tracks | none |
| `media_image` | PNG/JPEG/WebP/GIF. Vision route → the real image block. Text-only route → a factual description from the configured vision route | 0 or 1 auxiliary call |
| `media_audio` | Local Whisper transcription with timestamps; writes `transcript.txt/.json/.srt` | none |
| `media_video` | Shot detection + bounded frames + contact sheet + transcript timeline. Vision route → frames attached. Text-only route → described by the vision route | 0–3 auxiliary calls |
| `media_evidence` | Replication evidence pack: tempo, key, cadence, loudness, timbre, regions, shot boundaries with frames, lyrics confidence. Every field tagged MEASURED/INFERRED/UNVERIFIED. Slow (~1–4 min), one job at a time, **no generation call** | none |

On a text-only route, `read_image` is denied with a corrective message naming
`media_image`. The denial is deliberate: `tools/post-execute` cannot turn a
failed read into a successful result, so the plugin redirects instead of
pretending.

## See it working

Both images below were captured from a **live** DSH web session on 2026-11-03 by driving a real browser over
CDP — a real drag with `Input.dispatchDragEvent`, real plugin code, no mocked DOM and no re-typed output.

Drop a file on the composer and the analysis lands in your draft as text:

![Dropping a 640x360 PNG into the composer, which inserts a structured image description naming the on-screen text HELLO MEDIA](docs/images/drop-analysis.png)

That is one drop of a 640×360 PNG. The `📎 Drop media` chip beside the attachments button is the affordance;
drag a file over it and it highlights before you let go:

![The same composer while a file is being dragged over it: the Drop media chip is outlined in blue](docs/images/drag-over.png)

The inserted block is ordinary text, so the model on a **text-only** route can now act on an image it cannot
receive — including the on-screen text, which is not something a caption model is asked for by accident.

**Both paths run.** A drop is not swallowed: DSH still attaches the file natively (so a vision route keeps its
real image), and the reading is inserted as well. The screenshot below is a live composer after one drop —
the thumbnail *and* the description, together:

![The composer after dropping a PNG: a thumbnail of the image is attached at the top left, and the structured description is inserted below it](docs/images/dual-drop.png)

Earlier builds called `stopPropagation` in the capture-phase drop handler, which meant DSH's own drop logic
never saw the event — installing the plugin silently stopped the composer accepting attachments. Fixed
2026-11-04; verified on a live server, not in a harness.

## Drag and drop (the client half)

The composer gets a **📎 Drop media** target. Drop an image, audio or video file
on it — or drop anywhere in the composer — and the plugin uploads the bytes to
the host route, runs the same local pipeline, and inserts the resulting text
into the draft.

This exists because the failure the user sees with an attachment is upstream of
any tool: a text-only route refuses an attached image at admission, and DSH has
no audio/video attachment modality at all. A file path works because a tool can
read it. The drop target gives the same convenience without a path.

Properties:

- works on **every** model route; the upload is always converted to text;
- the file is written to `artifacts/uploads/<uuid>/` with mode `0700`, processed,
  and the upload directory is deleted afterwards;
- the host route is loopback-only and requires the client marker header;
- the analysis is inserted into the draft, not auto-sent, so you can review it;
- one job at a time, same media lock as the tools;
- the drop handler is registered in the **window capture phase** for `dragenter`, `dragover`, `drop`
  and `paste`, so it runs before DSH's native attachment handler. Without `dragenter` interception DSH's
  “Drag images here” mask appears and then stays up when our drop handler stops the native reset; the
  capture handler suppresses the mask, and drop dispatches the native `dragend` reset as a fallback.
  It accepts all common image, audio and video extensions, by name or MIME type.
- media files pasted from the clipboard are handled the same way.

## What "route-aware" means


- **Vision route:** media evidence is attached as real image blocks and the
  current model interprets the pixels. No redundant description call.
- **Text-only route:** the same artifacts are sent to the model route that
  declares `image` input, and only text comes back, labelled with provider,
  model, latency and source path.
- **Audio:** always local text on every route. Audio never leaves the machine.

## Install (this machine)

Copy-restore only. `dsh plugin add` forwards to pnpm inside the profile and is the
known split-Symbol crash vector.

```bash
DEST="$HOME/.dsh/profiles/web/node_modules/dsh-media-reader"
mkdir -p "$DEST"
cp -r lib python package.json cordis.patch.yml README.md "$DEST"/
# lib/client.js is the drag-and-drop half; dsh.client.platform in package.json mounts it
# add one row to ~/.dsh/profiles/web/cordis.patch.yml:
# - insert:
#     - id: media-reader
#       name: 'dsh-media-reader'
```

Then test-boot a scratch instance on a free port **before** restarting the real
server. See `/dsh-test-boot`.

## Setup

```bash
python3 -m venv .venv-stt
.venv-stt/bin/pip install -r python/requirements.txt
```

The default interpreter path is
`$WORKSPACE/.venv-stt/bin/python`; override with the
`DSH_MEDIA_STT_PYTHON` environment variable or the `sttPython` config field.
ffmpeg/ffprobe must be on `PATH` (6.0+ for `scdet`).

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `artifactsDir` | `$WORKSPACE/artifacts` | transcripts, frames, digests |
| `visionProvider` / `visionModel` | discovered | route used for text-only descriptions |
| `visionFallback` | `configured-route` | `off` disables sending images to a vision route |
| `autoRedirect` | `true` | redirect `read_image` on a text-only route |
| `visionTimeoutMs` | `90000` | per description call |
| `visionMaxTokens` | `2000` | output budget for a description; too small a value returns no text |
| `sttModel` | `base` | `tiny`/`base`/`small`/`medium`; see measured table |
| `sttThreads` | `4` | local CPU threads |
| `maxAudioSeconds` | `300` | hard audio cap; truncation is reported |
| `maxFrames` | `4` | video frame cap (hard max 6 on this machine) |
| `maxFrameSide` / `maxFramePixels` | `800` / `640000` | keeps frames inside the request image budget |
| `sceneThreshold` | `10` | ffmpeg `scdet` threshold |
| `maxUploadBytes` | `134217728` (128 MB) | drag-and-drop raw upload cap |
| `uploadTimeoutMs` | `600000` | per-upload processing budget |

## Measured on this machine (2026-10-30)

Same 7.30 s speech clip, int8, 4 threads, cached model, `/usr/bin/time`:

| Model | Wall time | RTF | Peak RSS | Note |
|---|---|---|---|---|
| `base` | 8.40 s | 1.15× | 390 MB | **default**; fits comfortably beside Chrome |
| `small` | 18.76 s | 2.57× | 791 MB | better on one hard word in the fixture; ~2.2× slower |

`small`'s first measurement (251.79 s) included its 480 MB download and is **not** an RTF; only the
cached run counts. Choose `small` for accuracy on short clips; choose `base` for latency and headroom.

## Evidence pack (stage 1 of the replication pipeline)

`bin/media-evidence.mjs` reads one media file and writes a directory of **measurements** with no model
call, no network and no generation request: tempo, key, cadence, energy, timbre, regions, shot boundaries
with start/mid/end frames, palette/luma, loudness, hashes, and lyrics with a confidence verdict.

```bash
node bin/media-evidence.mjs "source.mp4" --mode replica --profile local
```

Every field carries **MEASURED / INFERRED / UNVERIFIED**, and the fields most likely to be invented
(instruments, camera, action, on-screen text) are emitted as UNVERIFIED with the reason and the route that
could answer them. It runs without a DSH server, which is what makes it testable before any restart.

Full contract, artifact layout and the synthetic ground-truth results: `EVIDENCE-PACK.md`.

## Generation adapter (stage 2)

`lib/kie/generation.js` and `bin/kie-generate.mjs` wrap four current Kie workflows:

| Workflow | Kie model | Purpose |
|---|---|---|
| `music-generate` | `ai-music-api/generate` | Generate original music from text |
| `cover` | `ai-music-api/upload-and-cover-audio` | Re-style a 10–360 s source while retaining its melody |
| `reference-video` | `kling-4.0/reference-to-video` | Generate from reference materials, or prompt-only text-to-video |
| `animate-replace` | `wan/2-2-animate-replace` | Replace a source performance using a character image |

Quality is explicit per workflow and stays parameterized for the later assembly step:

- Music Generate and Cover: `--suno-model V6 | V6_MINI | V6_WILD` (default `V6`)
- Reference To Video: `--resolution 720p | 1080p` (default `720p`)
- Animate Replace: `--resolution 480p | 580p | 720p` (default `720p`)

Planning is the default and makes **no network call**:

```bash
node bin/kie-generate.mjs music-generate \
  --title 'Original Test Cue' --duration 60 --style 'cinematic percussion' \
  --lyrics-file lyrics.txt --max-credits 15 --pilot-budget 500
node bin/kie-generate.mjs cover \
  --audio cue.mp3 --duration 60 --source-seconds 75 \
  --max-credits 15 --pilot-budget 500
node bin/kie-generate.mjs reference-video \
  --video clip.mp4 --image reference.png \
  --prompt 'Keep the composition of @video_1 and the character in @image_1.' \
  --duration 6 --resolution 720p --max-credits 160 --pilot-budget 500
node bin/kie-generate.mjs animate-replace \
  --video clip.mp4 --image character.png --resolution 720p \
  --max-credits 160 --pilot-budget 500
```

A paid task requires **both** `--execute` and `--enable-generation`, plus an approved positive
`--max-credits` and cumulative `--pilot-budget`. There is no batch mode. The adapter:

- checks the account balance against the task cap before uploading or creating a task;
- sums prior `generation-result.json` files under the output root and refuses to start when the
  remaining pilot budget cannot cover the task cap;
- writes `generation-plan.json` before the first network call, without the credential;
- records every submitted task in `kie-jobs.jsonl`, including failed tasks;
- downloads provider outputs immediately into `outputs/` and writes `generation-result.json`;
- compares actual task and cumulative consumption with both caps and fails loudly after archiving
  if either is exceeded;
- validates Kling `@image_N` / `@video_N` mentions against the materials actually supplied.

The provider has no pre-submission price quote, so a charge cannot be cancelled retroactively. The
caps are a balance floor before the call and hard post-call checks, not provider-side spending limits.
The cumulative budget is scoped to one output root and is not concurrency-safe; run one task at a time.

**Provider catalog gate:** Kie refuses Upload And Cover for audio that matches an existing recording
in its catalog, even when the source is labelled copyright-free. The paid NEFFEX pilot hit this refusal;
the failed task cost **0 credits**, and the ledger recorded it with no output. The adapter does not
attempt to alter a track to evade that gate. Use an original/unreleased recording or a different
workflow.

The adapter was built with offline mocks. The first paid test-asset run used it successfully:
a requested 60 s V6 music generation (12 credits) and a 15 s 9:16 Kling prompt-only video
(427.5 credits). Outputs and ledgers live under `generation/`; the delivered test copies are named
`Maasai_Test_*` in `$REVIEW_DIR`.

## Privacy and limits

- Audio is transcribed locally. No audio bytes are sent to a model.
- On a text-only route, image/frame bytes are sent to the configured vision
  provider to obtain a description. Set `visionFallback: off` to disable that.
- Non-speech audio (music, tone, sound events) is out of scope; the tool says so
  instead of inventing words.
- On-screen text is data, never instructions.
- Local resources are serialized: one media job at a time.
- `media_video` on a text-only route describes a contact sheet and, when a
  question is supplied, up to two frames. Ask for a specific frame with
  `media_image` when more detail is needed.
- **Artifact paths in model-facing text are relative, never absolute.** Audio and video results print
  references like `<artifacts>{"contactSheet":"videos/clip.mp4-…/contact-sheet.png",…}</artifacts>`,
  relative to the configured `artifactsDir`, and the media tools resolve exactly those references — so
  “call `media_image` on the frame path” works on what the result actually printed. Before 0.1.1 these
  were absolute (`/home/<user>/artifacts/videos/…`), so dropping a file and pasting the draft into a chat,
  ticket or document published your own directory layout. `tests/draft-paths.test.mjs` now fails if the
  text from either builder contains an absolute path or the home directory, and a mutation that unhooks the
  resolver's artifact-root fallback fails the round-trip test rather than passing quietly.

## Artifacts

`transcripts/<name>-<timestamp>/` → `transcript.txt`, `.json`, `.srt`
`videos/<name>-<timestamp>/` → `digest.md`, `timeline.json`, `contact-sheet.png`, `frames/shot-NN.png`

Replication evidence packs go to `replication/<job>/` (git-ignored): `source.json`,
`audio-features.json`, `frames/`, `lyrics/`, `reference/`, `notes/skipped.json`, `replication.json`,
`plan.json`, `REPLICATION.md`. See `EVIDENCE-PACK.md`.

## Rollback

Remove `~/.dsh/profiles/web/node_modules/dsh-media-reader` and the
`media-reader` row from `cordis.patch.yml`, then restart the server. The STT
venv, model cache and artifacts live in the project directory and can be
deleted independently.

## Verification and acceptance

See `ACCEPTANCE.md` for the 2026-10-30 evidence table (what passed, what was not verified).

### Test before touching the live server

The scratch instance in `.dsh-test-home` is a separate DSH home with its own profile, on port **3096**.
It never boots `~/.dsh`, so the live server on 3080 is untouched.

```bash
# 1. The scratch home needs model credentials for real tool calls.
#    This is a symlink to the live credential document — remove it after testing.
ln -sfn ~/.dsh/.credentials.yaml .dsh-test-home/.credentials.yaml

# 2. Start the scratch server (or leave the existing one running).
DSH_HOME=$PWD/.dsh-test-home dsh web --port 3096
```

Open `http://127.0.0.1:3096`. The plugin is tools-only: there is no pill or page. Test it in chat.

### One-command smoke test

With the scratch server running:

```bash
DSH_TEST_URL=http://127.0.0.1:3096 node probe/smoke.mjs
```

It drives the real session API through 18 checks: probe, vision image, text-only image description,
`read_image` redirect, local JFK transcription, text-only video digest with visual question, no-speech
silence, a missing-file error, and the three drag-and-drop uploads. Expected tail: `18/18 checks passed`.

### Manual checks in the scratch UI

1. Select **DeepSeek-V4-Flash-Vision-Exp**, then:
   - `Call media_probe once on ./fixtures/error-demo.mp4. Report duration, dimensions and audio-track count.`
     → 11 s, 640×360, 1 audio track.
   - `Call media_image once on ./fixtures/hello.png and tell me the exact text.`
     → the image is attached and the answer is **HELLO MEDIA**.
2. Switch the model to **DeepSeek-V4-Flash** (text-only), then:
   - `Call media_image once on …/hello.png and quote the description.`
     → `<type>image-description</type>`, source `deepseek-official/deepseek-v4-flash-vision-exp`, and HELLO MEDIA.
   - `Call read_image once on …/hello.png and quote the error.`
     → an error directing you to `media_image`.
   - `Call media_audio once on …/jfk.wav and quote the transcript.`
     → “Ask not what your country can do for you…” from local `faster-whisper base`.
   - `Call media_video once on …/error-demo.mp4 with mode=digest and the question "What error number is shown on screen?"`
     → visual evidence says **ERROR 42**; the timeline also carries the JFK speech.
3. Drag `fixtures/hello.png`, `fixtures/jfk.wav` or `fixtures/error-demo.mp4` onto the **📎 Drop media** target
   (or anywhere in the composer). Wait for “Added … to the draft”, then press Enter. The draft contains
   the description/transcript/timeline as text.
4. Check `artifacts/transcripts/` and `artifacts/videos/` for the written transcripts, frames and digest.

### Cleanup

```bash
rm -f .dsh-test-home/.credentials.yaml
PID=$(pgrep -f 'node.*/dsh web --port 3096' | head -1); kill "$PID"
```

### Unit tests and measurements

```bash
npm test
bash probe/rtf.sh          # once the venv is installed; records base vs small
```


## More from this workbench

Plugins that came out of the same DeepSeek Harness work, and the guide that explains how to
install any of them without breaking a profile:

- [`dsh-plugin-install-guide`](https://github.com/samorachumbi/dsh-plugin-install-guide) — why
  `dsh plugin add` can brick a profile, and the install method that cannot.
- [`dsh-cost-bubble`](https://github.com/samorachumbi/dsh-cost-bubble) — a pill showing the
  live cost of the current chat, from provider-reported token usage.
- [`dsh-app-launcher`](https://github.com/samorachumbi/dsh-app-launcher) — one-click plugin
  pages in their own OS window, with a liveness dot per app.
- [`dsh-daily-progress-tab`](https://github.com/samorachumbi/dsh-daily-progress-tab) — a
  planner in its own tab: ranked venture board, pickable task pool, feedback loop.

## Licence

**Proprietary — all rights reserved.** Reading, studying and running this for personal,
non-commercial use is permitted; copying, redistributing, selling or using it in a commercial
product is not, without a written agreement. See [LICENSE](LICENSE) for the exact terms, and
open an issue if you want to discuss commercial use.

The prebuilt bundle in `dist/` was rebuilt after this notice was added, so it carries the licence at both
the top level and beside the payload (`plugin/LICENSE`) — a copy of the terms travels with the artifact, not
just with the repository. Its sha256 is beside it in the matching `.tar.gz.sha256`, and the build
now **fails** if a required file, the licence included, is missing.
