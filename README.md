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
.venv-stt/bin/pip install faster-whisper==1.2.1
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
| `sttModel` | `small` | `tiny`/`base`/`small`/`medium` |
| `sttThreads` | `4` | local CPU threads |
| `maxAudioSeconds` | `300` | hard audio cap; truncation is reported |
| `maxFrames` | `4` | video frame cap (hard max 6 on this machine) |
| `maxFrameSide` / `maxFramePixels` | `800` / `640000` | keeps frames inside the request image budget |
| `sceneThreshold` | `10` | ffmpeg `scdet` threshold |

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

## Verification

```bash
npm test
bash probe/rtf.sh          # once the venv is installed; records base vs small
```
