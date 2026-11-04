# dsh-media-reader — install bundle

Give a DeepSeek Harness agent **eyes and ears**: read local images, audio and video — including on a model
route that cannot accept media at all — and turn a video into a **text evidence pack** (shots, frames,
music key/loudness/onsets, chords, transcripts) that any text-only model can work from.

Readable as plain text on purpose: a human can install it, and an LLM can read this file and act on it.

---

## What you are installing

| Piece | What it does |
|---|---|
| **plugin/** (`dsh-media-reader` <version>) | five tools — `media_probe`, `media_image`, `media_audio`, `media_video`, `media_evidence` — a `read_image` redirect for text-only routes, and a composer drop target |
| **skills/product-motion-studio** | the production method: brief → evidence map → storyboard → references → motion → deterministic assembly → acceptance gates. Without it the tools give you media access but no standards |
| **skills/dsh-plugin-install-safety** | why `dsh plugin add` must never be used here, and the copy-restore method plus the duplicate guard that prevents the split-Symbol crash |
| **skills/dsh-skill-install** | how to make a skill loadable and slash-invocable under `$DSH_HOME/skills` |
| **skills/dsh-test-boot** | boot a scratch instance BEFORE restarting the real server, and leave it up for the user to look at |
| **docs/** | the research, the production pipeline, the acceptance record, the evidence-pack format, the two direction workflows, and the reproducible film-pipeline commands |
| **fixtures/** | the small files the smoke test needs |
| **install.sh / install-skills.sh / uninstall.sh / smoke.sh** | everything, in four commands, reversible |
| **LICENSE** | the terms you are granted — proprietary, all rights reserved; personal non-commercial use only |

Requirements: **node**, **ffmpeg**, **python3** (with `faster-whisper` + `av` in a venv for local
transcription — see `docs/README.md`). No package manager is used and none is required.

---

## Install (5 minutes)

```bash
tar -xzf dsh-media-reader-<version>.tar.gz
cd dsh-media-reader-<version>

./install.sh --dry-run          # read every action first
./install.sh                    # copies the plugin into the profile, registers it, runs the guard
./install-skills.sh             # links the four skills into $DSH_HOME/skills
```

Then restart the DSH server so the tools register. Before you do that on a machine you care about, follow
`skills/dsh-test-boot/SKILL.md`: boot a second instance on a spare port, check it, and only then restart the
real one.

Verify for real (not just "it installed"):

```bash
DSH_TEST_URL=http://127.0.0.1:3096 ./smoke.sh
```

18 checks run against real sessions on **both** a vision route and a text-only route. The text-only checks
are the point: an image is returned as a factual description, the built-in `read_image` is redirected to
`media_image`, audio comes back as a transcript, and a video comes back as a described shot timeline with
the spoken transcript fused in.

Rollback: `./uninstall.sh` removes the copy and the patch row, and touches nothing else.

---

## The five tools

| Tool | Input | Returns |
|---|---|---|
| `media_probe` | any media file | ffprobe facts: kind, duration, dimensions, fps, codecs, audio/subtitle tracks |
| `media_image` | PNG/JPEG/WebP/GIF | vision route → the real image block; text-only route → a factual description from the configured vision route |
| `media_audio` | audio or video | local Whisper transcript with timestamps (`transcript.txt/.json/.srt`) |
| `media_video` | video | shot detection + bounded key frames + contact sheet + transcript fused to the shot timeline |
| `media_evidence` | video or audio | the full replication pack: tempo/key/loudness/timbre/regions/onsets, chord segments, shot boundaries with frames, lyrics confidence — every field tagged `MEASURED` / `INFERRED` / `UNVERIFIED` |

`media_evidence` is the important one: it is what lets a text-only model reason about a video it cannot
see. It is slow (1–4 minutes) and makes **no** generation call and no network request in the `local`
profile.

---

## Verification of this exact bundle

Built, installed and checked on 2026-11-03 from the tarball itself — not from the development tree:

```
./install.sh --home <clean-home> --profile web      # copy-restore, patch row, duplicate guard
./uninstall.sh --home <clean-home> --profile web    # removes only what it created
tar -xzf ... && ./install.sh (into the scratch profile) && ./smoke.sh
18/18 checks passed
```

All fifteen tool checks and the three drop-upload checks passed on the installed copy, on both a vision
route and a text-only route. `MANIFEST.json` lists every file with its sha256 so you can confirm what you
received.

## Adapt it to your own subject

Nothing in the pipeline names a subject. The portability contract is in `skills/product-motion-studio`:
one identity anchor per recurring subject, one scene per shot, motion in every shot, measured prices
rather than published ones, and every claim tagged with its evidence strength. A product film, a food
film, an architecture film and a music video follow the same pipeline; only the plates and the beats
change.

Provider ids, prices and limits **must be re-measured at run time** — `docs/PRODUCTION-PIPELINE.md` and
the skill both say so, because the published "from" price is the cheapest tier, not the tier you order.

---

## What this bundle deliberately does not do

- It never installs with a package manager (that is the crash vector this bundle exists to avoid).
- It never publishes anything, calls a generation provider, or spends credits.
- It does not claim to verify visual quality: acceptance is a separate, image-capable review, and the
  skill requires that verdict to be recorded next to the artifact.
- It does not include credentials. Any API key stays in the installer's own environment.

## Licence and provenance

**Proprietary — all rights reserved.** The full terms are in `LICENSE`, which ships in this bundle at both
the top level and beside the payload in `plugin/LICENSE`. In short: you may read, study, install and run
this for your own **personal, non-commercial** use; you may not copy, redistribute, resell or use it in a
commercial product without a written agreement. Commercial use is available on paid terms — open an issue at
<https://github.com/samorachumbi/dsh-media-reader/issues>.

Third-party components keep their own licences: `ffmpeg`, `faster-whisper` and the Whisper model weights
(downloaded at run time, **not** redistributed here), and the DeepSeek Harness packages. Those licences are
unaffected by the notice above.

Provenance: see `docs/ACCEPTANCE.md` for what was verified, on which date and harness version, and what
remains unverified. Model ids and prices in `docs/` are dated observations, not guarantees — re-check them.
