# dsh-media-reader

Read local **images, audio and video** from DeepSeek Harness — including on a
model route that cannot accept images.

Four tools and one redirect:

| Tool | What it does | Model calls |
|---|---|---|
| `media_probe` | ffprobe metadata: kind, duration, dimensions, fps, codecs, audio/subtitle tracks | none |
| `media_image` | PNG/JPEG/WebP/GIF. Vision route → the real image block. Text-only route → a factual description from the configured vision route | 0 or 1 auxiliary call |
| `media_audio` | Local Whisper transcription with timestamps; writes `transcript.txt/.json/.srt` | none |
| `media_video` | Shot detection + bounded frames + contact sheet + transcript timeline. Vision route → frames attached. Text-only route → described by the vision route | 0–3 auxiliary calls |

On a text-only route, `read_image` is denied with a corrective message naming
`media_image`. The denial is deliberate: `tools/post-execute` cannot turn a
failed read into a successful result, so the plugin redirects instead of
pretending.

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
`~/projects/Video_Image_Voice/.venv-stt/bin/python`; override with the
`DSH_MEDIA_STT_PYTHON` environment variable or the `sttPython` config field.
ffmpeg/ffprobe must be on `PATH` (6.0+ for `scdet`).

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `artifactsDir` | `~/projects/Video_Image_Voice/artifacts` | transcripts, frames, digests |
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

## Measured on this machine (2026-10-30)

Same 7.30 s speech clip, int8, 4 threads, cached model, `/usr/bin/time`:

| Model | Wall time | RTF | Peak RSS | Note |
|---|---|---|---|---|
| `base` | 8.40 s | 1.15× | 390 MB | **default**; fits comfortably beside Chrome |
| `small` | 18.76 s | 2.57× | 791 MB | better on one hard word in the fixture; ~2.2× slower |

`small`'s first measurement (251.79 s) included its 480 MB download and is **not** an RTF; only the
cached run counts. Choose `small` for accuracy on short clips; choose `base` for latency and headroom.

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

## Artifacts

`transcripts/<name>-<timestamp>/` → `transcript.txt`, `.json`, `.srt`
`videos/<name>-<timestamp>/` → `digest.md`, `timeline.json`, `contact-sheet.png`, `frames/shot-NN.png`

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

It drives the real session API through 15 checks: probe, vision image, text-only image description,
`read_image` redirect, local JFK transcription, text-only video digest with visual question, no-speech
silence, and a missing-file error. Expected tail: `15/15 checks passed`.

### Manual checks in the scratch UI

1. Select **DeepSeek-V4-Flash-Vision-Exp**, then:
   - `Call media_probe once on /home/samora/projects/Video_Image_Voice/fixtures/error-demo.mp4. Report duration, dimensions and audio-track count.`
     → 11 s, 640×360, 1 audio track.
   - `Call media_image once on /home/samora/projects/Video_Image_Voice/fixtures/hello.png and tell me the exact text.`
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
3. Check `artifacts/transcripts/` and `artifacts/videos/` for the written transcripts, frames and digest.

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

