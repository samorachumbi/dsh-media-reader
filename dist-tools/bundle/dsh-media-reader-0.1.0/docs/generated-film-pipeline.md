# Generated film pipeline — reproducible commands

Verified 2026-11-02/03 on *Essence of the Maasai* (149.232 s, 31 unique scenes, 12 s continuous jump,
accepted by the independent reviewer). This is the mechanical half; the rules are in
[[product-motion-studio-SKILL]] section "Generated film pipeline".

## 1. Price the route before planning

Probe the model once at the resolution you intend to use and read `actualCredits` from the ledger — the
published "from" figure is the cheapest tier.

- `bytedance/seedance-2-mini`: **8.2 credits/s at 720p**, **3.8 at 480p** (measured)
- 720p for faces/hands/garment; 480p for scenery, herds, crowd wides

## 2. Generate one beat at a time

```bash
node scripts/kie-beat.mjs --beat <id>                    # dry run, prints prompt + cost
node scripts/kie-beat.mjs --beat <id> --execute --max-credits <ceiling>
```

The adapter: refuses to overwrite an archived clip, asserts the budget from the *measured* rate, writes
`assets/generated/beats/<id>.mp4`, copies a review-titled version into the operator's music folder, and
ledgers the result JSON with prompt, task id and actual credits.

## 3. Review the beat before it is cut in

```bash
bash scripts/prepare-motion-review.sh <clip.mp4> <label>   # contact sheet + 4 fps frames
python3 scripts/measure-motion.py --frames <frames dir>     # head/foot spans, backdrop drift, jitter
python3 scripts/make-motion-sheets.py --frames <dir> --out <dir>   # face/body/hands/feet sheets
```

Send those images to the image-capable reviewer with a PASS/FAIL list. Record the verdict next to the
artifact. Do not accept a beat on a download.

## 4. Build the edit as a uniqueness contract

```bash
python3 scripts/make-edl-v2.py --check     # fails on a duplicate beat, a gap, or a wrong total
python3 scripts/build-film2.py --edl renders/edl-v2.json --out renders/film.mp4
```

The EDL is JSON: one segment per storyboard shot, each naming its own beat, crop, in-point and speed.
Frames stream into ffmpeg, so no intermediate image pile is written. Re-cutting costs nothing.

## 5. Cut to detected onsets, not to sections

```bash
ffmpeg -i song.mp3 -ac 1 -ar 22050 -f s16le analysis/song22k.raw
python3 scripts/detect-onsets.py           # spectral flux, 16 Goertzel bands -> analysis/cuts.json
```

Section-energy cutting produced a grid measured a median 180 ms off the strong accents. Spectral flux
plus local-neighbourhood thinning puts every cut on a detected onset; claim that, not accent alignment.

## 6. Deterministic framing repair

```bash
python3 scripts/reframe_identity.py <still> <out> --scale 0.75 --offset-y 120 --pad-mode mirror
python3 scripts/pad-jump.py --src beats/hero.mp4 --out beats/hero-padded.mp4 --pad 170
```

`reframe_identity.py` pads a still with a subject-free mirrored backdrop (never a plain rectangle, never a
blurred ghost of the subject). `pad-jump.py` adds sky above a clip; it must sample the **outer thirds per
frame** — per-column sampling grows a stripe from the subject's hair, a single static strip freezes while
the sky brightens (measured as a 10.6-20.2 level seam), and the working version lands at 1.4 levels.

## 7. Verify what you deliver

```bash
bash scripts/verify-film.sh <film.mp4> <label>   # container facts, 10 s contact sheet, title frame
npm test                                          # guards, including the ones shown to fail on the real defect
```

Then the exit gate, the delivery note with an explicit "not verified" list, and the reviewer's verdict
pasted into it.

## What this pipeline does not do

- It does not make a group scene safe: a wide generated night clip inserted a second, differently dressed
  jumper into the hero's beat. Crowds are filler, heroes are composited or shot alone.
- It does not prove audio/picture sync on a real device, and it does not prove accent-level musicality.
- It does not replace the reviewer. Six of the seven defects found in the last build were caught by
  independent review, not by a metric.
