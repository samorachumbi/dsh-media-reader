/**
 * Evidence grading and pack assembly.
 *
 * The one rule this file enforces: **no field exists without an evidence tag**.
 * MEASURED means a number came out of a measurement over the real samples or
 * pixels. INFERRED means the measurement exists but is not decisive (a key with a
 * narrow margin, a tempo with a rival octave). UNVERIFIED means the pack does not
 * know and says so — with the reason and, where one exists, the route that could
 * answer it later.
 *
 * The graders are pure functions so the thresholds can be argued with and tested
 * rather than buried in a template string.
 */

export const EVIDENCE = Object.freeze({
  MEASURED: 'MEASURED',
  INFERRED: 'INFERRED',
  UNVERIFIED: 'UNVERIFIED'
})

/** Build one tagged field. */
export function field(value, evidence, note) {
  const tagged = { value, evidence }
  if (note !== undefined && note !== null) tagged.note = note
  return tagged
}

function round(value, digits) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/**
 * Tempo is decisive only when the winning family beats its nearest rival and no
 * near-equal octave exists. Both conditions are visible in the numbers.
 */
export function gradeTempo(tempo) {
  if (tempo === null || tempo === undefined) {
    return field(null, EVIDENCE.UNVERIFIED, 'no pulse was measurable in this audio')
  }
  const octave = tempo.octaveAlternative
  const noteParts = [`confidence ${tempo.confidence} from the harmonically-summed autocorrelation`]
  if (octave !== null && octave !== undefined) {
    noteParts.push(`a ${octave.relation}-tempo reading at ${octave.bpm} BPM scores ${octave.score}; the pulse and its octave are the same signal`)
  }
  if (Array.isArray(tempo.candidates) && tempo.candidates.length > 1) {
    noteParts.push(`rival candidates: ${tempo.candidates.slice(1, 4).map((candidate) => candidate.bpm).join(', ')} BPM`)
  }
  const evidence = tempo.confidence >= 0.6 && tempo.ambiguous !== true && (octave === null || octave === undefined)
    ? EVIDENCE.MEASURED
    : tempo.confidence >= 0.3
      ? EVIDENCE.INFERRED
      : EVIDENCE.UNVERIFIED
  return field(round(tempo.bpm, 2), evidence, noteParts.join('; '))
}

/** A key is measured only when the correlation and its margin over the runner-up agree. */
export function gradeKey(key) {
  if (key === null || key === undefined) {
    return field(null, EVIDENCE.UNVERIFIED, 'the chroma carried no usable pitch-class contrast')
  }
  const note = `Krumhansl-Kessler correlation ${key.correlation}, margin over the runner-up ${key.margin}`
  const evidence = key.correlation >= 0.6 && key.margin >= 0.05
    ? EVIDENCE.MEASURED
    : key.correlation >= 0.4
      ? EVIDENCE.INFERRED
      : EVIDENCE.UNVERIFIED
  return field(`${key.tonic} ${key.mode}`, evidence, note)
}

/** Cadence is measured from onsets and the beat grid; it says nothing about genre. */
export function gradeCadence(cadence, onsets, tempoTag) {
  if (cadence === null || cadence === undefined || cadence === null) {
    return field(null, EVIDENCE.UNVERIFIED, 'too few onsets or beats to describe a rhythm pattern')
  }
  const onsetCount = onsets?.count ?? 0
  const noteParts = []
  if (Number.isFinite(cadence.ioiMedianSec)) {
    noteParts.push(`median inter-onset interval ${cadence.ioiMedianSec}s`)
  }
  if (Number.isFinite(cadence.dominantIoiSec)) {
    noteParts.push(`most common subdivision ${cadence.dominantIoiSec}s`)
  }
  if (Number.isFinite(cadence.beatAlternationRatio)) {
    // Only read the alternation as "the pulse is half the reported tempo" when the
    // tempo reading is strong enough to be a reference point at all; on a speech
    // clip it would be an interpretation built on an unverified number.
    const interpretive = cadence.beatAlternationRatio > 0.35 && tempoTag?.evidence !== EVIDENCE.UNVERIFIED
    noteParts.push(`alternate-beat difference ${cadence.beatAlternationRatio}${interpretive ? ' — the real beat is probably half the reported tempo' : ''}`)
  }
  if (Number.isFinite(cadence.accentSpread4)) {
    noteParts.push(`accent spread over 4 beat positions ${cadence.accentSpread4}`)
  }
  noteParts.push(`${onsetCount} loudness onsets detected`)
  // Inter-onset statistics stand on their own; the accent pattern, the
  // alternate-beat difference and the grid deviation are all computed ON the
  // beat grid, so their strength cannot exceed the tempo's. Claiming them
  // MEASURED while the tempo itself is INFERRED was an over-claim.
  const gridDependent = Number.isFinite(cadence.beatAlternationRatio) || Number.isFinite(cadence.accentSpread4)
  const tempoEvidence = tempoTag?.evidence ?? EVIDENCE.UNVERIFIED
  if (gridDependent && tempoEvidence !== EVIDENCE.MEASURED) {
    noteParts.push(`accent, alternation and grid deviation are measured on the beat grid, whose own evidence is ${tempoEvidence}`)
  }
  const evidence = gridDependent && tempoEvidence !== EVIDENCE.MEASURED
    ? (tempoEvidence === EVIDENCE.UNVERIFIED ? EVIDENCE.UNVERIFIED : EVIDENCE.INFERRED)
    : EVIDENCE.MEASURED
  return field(cadence, evidence, noteParts.join('; '))
}

export function gradeSections(sections) {
  if (!Array.isArray(sections) || sections.length === 0) {
    return field([], EVIDENCE.UNVERIFIED, 'no character change cleared the novelty threshold')
  }
  return field(
    sections,
    EVIDENCE.MEASURED,
    `${sections.length} regions from chroma/energy novelty. These are measured boundaries, not verse or chorus labels — naming them is a semantic claim this pack does not make`
  )
}

export function gradeLoudness(loudness) {
  if (loudness === null || loudness === undefined || loudness.integratedLufs === null) {
    return field(null, EVIDENCE.UNVERIFIED, 'ffmpeg ebur128 produced no integrated loudness for this file')
  }
  return field(loudness, EVIDENCE.MEASURED, 'EBU R128 integrated loudness, loudness range and true peak from ffmpeg')
}

export function gradeLyrics(lyrics) {
  if (lyrics === null || lyrics === undefined) {
    return field(null, EVIDENCE.UNVERIFIED, 'lyrics were not requested for this pack')
  }
  const confidence = lyrics.confidence
  if (confidence.segments === 0) {
    return field(
      { text: '', summary: confidence },
      EVIDENCE.UNVERIFIED,
      'no speech-like segments were detected, so there is no lyric text to grade'
    )
  }
  const evidence = confidence.verdict === 'speech-like' ? EVIDENCE.MEASURED : EVIDENCE.INFERRED
  const note = confidence.verdict === 'speech-like'
    ? `mean per-segment log-probability ${confidence.meanAvgLogprob}, ${confidence.words} words`
    : `mean per-segment log-probability ${confidence.meanAvgLogprob} and mean no-speech probability ${confidence.meanNoSpeechProb}: Whisper is transcribing a sung vocal, so treat the text as an approximation, not the lyric`
  return field(
    {
      text: lyrics.transcript.text,
      segments: lyrics.transcript.segments.length,
      words: confidence.words,
      language: lyrics.transcript.language,
      summary: confidence
    },
    evidence,
    note
  )
}

/**
 * Instruments are the field most likely to be invented, so the pack refuses to
 * produce one from local measurements: no separator and no classifier ran.
 */
export function gradeInstruments() {
  return field(
    null,
    EVIDENCE.UNVERIFIED,
    'no stem separation and no instrument classifier ran. Naming instruments from a mix would be a guess; the assisted profile routes this to a native audio model'
  )
}

const SCALE_STEPS = Object.freeze({
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10, 11] // natural minor plus the raised seventh
})

/**
 * How much of the chord reading fits the measured key.
 *
 * Key and chords are two independent heuristics over the same chroma. When they
 * agree that is real corroboration; when they disagree the pack should say so
 * rather than printing both as equally settled. Measured on the epic track: 24 of
 * 24 segments fit E major's diatonic set, which is why the key can be called
 * MEASURED while the chords stay INFERRED.
 */
export function keyChordFit(chordSegments, keyValue) {
  if (!Array.isArray(chordSegments) || chordSegments.length === 0) return null
  if (typeof keyValue !== 'string') return null
  const match = keyValue.match(/^([A-G]#?)\s+(major|minor)$/u)
  if (match === null) return null
  const rootIndex = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'].indexOf(match[1])
  if (rootIndex < 0) return null
  const scale = new Set(SCALE_STEPS[match[2]].map((step) => (rootIndex + step) % 12))
  const chordIntervals = { major: [0, 4, 7], minor: [0, 3, 7] }
  let total = 0
  let fitting = 0
  for (const segment of chordSegments) {
    const chordMatch = String(segment.chord).match(/^([A-G]#?)\s+(major|minor)$/u)
    if (chordMatch === null) continue
    const chordRoot = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'].indexOf(chordMatch[1])
    if (chordRoot < 0) continue
    total += 1
    const tones = chordIntervals[chordMatch[2]].map((step) => (chordRoot + step) % 12)
    if (tones.every((pitch) => scale.has(pitch))) fitting += 1
  }
  if (total === 0) return null
  return { fitting, total, ratio: Math.round((fitting / total) * 1000) / 1000 }
}

/** Chord candidates are an interpretation of measured chroma, never a measurement. */
export function gradeChords(chords, keyValue) {
  if (chords === null || chords === undefined || !Array.isArray(chords.segments) || chords.segments.length === 0) {
    return field(null, EVIDENCE.UNVERIFIED, chords?.note ?? 'no chord cleared the confidence floor')
  }
  const fit = keyChordFit(chords.segments, keyValue)
  const noteParts = [chords.method ?? 'triad templates over the measured chroma']
  if (fit !== null) {
    noteParts.push(
      `${fit.fitting} of ${fit.total} segments fit the measured key's diatonic set (${fit.ratio}); ` +
      'the remainder are treated as passing chords or mis-detections rather than key changes'
    )
    if (fit.ratio < 0.8) {
      noteParts.push(
        'the third of a triad is the least reliable part of a whole-mix chroma reading, so major/minor ' +
        'confusion is expected; confidence, not the label alone, is what to read'
      )
    }
  }
  return field(
    chords.segments.map((segment) => ({
      startSec: segment.startSec,
      endSec: segment.endSec,
      chord: segment.chord,
      confidence: segment.confidence
    })),
    EVIDENCE.INFERRED,
    noteParts.join('; ')
  )
}

/**
 * Stems are MEASURED in the one sense that matters: the files exist, and each
 * one was decoded and measured here. The separation itself is the provider's
 * approximation, which the note says.
 */
export function gradeStems(stems, stemsError) {
  if (stems === null || stems === undefined) {
    return field(
      null,
      EVIDENCE.UNVERIFIED,
      stemsError === undefined || stemsError === null
        ? 'no stem separation ran for this pack'
        : `stem separation was attempted and refused: ${stemsError}`
    )
  }
  return field(
    {
      provider: stems.provider,
      model: stems.model,
      taskId: stems.taskId,
      creditsSpent: stems.creditsSpent ?? null,
      stems: stems.stems.map((stem) => ({
        label: stem.label,
        bytes: stem.bytes,
        file: stem.path,
        measured: stem.measured ?? null
      }))
    },
    EVIDENCE.MEASURED,
    `${stems.stems.length} stems separated by ${stems.provider}/${stems.model} and each decoded and measured locally. ` +
    'The separation is the provider\'s approximation of the mix, not the original multitrack'
  )
}

/** The semantic pass is a model's interpretation, so it can only ever be INFERRED. */
export function gradeSemantic(semantic, profile) {
  if (semantic === null || semantic === undefined) {
    return field(
      null,
      EVIDENCE.UNVERIFIED,
      profile === 'local'
        ? 'the local profile makes no model call; run the assisted profile for instrument, vocal and camera interpretation'
        : 'the semantic pass did not run for this pack'
    )
  }
  return field(
    semantic.fields,
    EVIDENCE.INFERRED,
    `${semantic.model} conditioned on the measured fields, ${semantic.mediaCount} media item(s)` +
    (typeof semantic.audio === 'string' ? ` including ${semantic.audio}` : '') +
    `, ${semantic.latencyMs} ms. A model\'s interpretation is not a measurement; treat every value here as a hypothesis`
  )
}

/** The full shot inventory: every boundary, not only the sampled ones. */
export function gradeShotInventory(shots) {
  if (shots === null || shots === undefined || !Array.isArray(shots.boundaries) || shots.boundaries.length === 0) {
    return field(null, EVIDENCE.UNVERIFIED, 'no shot boundaries were detected')
  }
  const durations = shots.boundaries.map((shot) => shot.durationSec)
  return field(
    {
      detected: shots.boundaries.length,
      sampled: shots.shots.length,
      longestShotSec: Math.max(...durations),
      medianShotSec: durations.slice().sort((a, b) => a - b)[Math.floor(durations.length / 2)]
    },
    EVIDENCE.MEASURED,
    'every boundary from ffmpeg scdet is recorded in shots.json; the sampled subset is what has frames on disk'
  )
}

/** Pilot clips chosen for generation, with the constraints that chose them. */
export function gradePilotShots(shots) {
  if (shots?.pilots === undefined || shots.pilots.pilots.length === 0) {
    return field(null, EVIDENCE.UNVERIFIED, shots?.pilots?.note ?? 'no pilot clip could be cut')
  }
  const single = shots.pilots.singleShot === true || (shots.boundaries ?? []).length === 1
  if (single) {
    // Advice and data used to disagree here: the note said "use the keyframe" while
    // a 0-8 s pilot window was still printed as if it were a usable clip. A
    // single-shot video has no cut to reference, so the pilot is the frame.
    const sample = (shots.shots ?? [])[0]
    const midFrame = sample?.frames?.find((frame) => frame.role === 'mid')
    return field(
      {
        mode: 'keyframe',
        detectedShot: sample?.detectedShot ?? 1,
        atSec: midFrame?.atSec ?? round((sample?.startSec ?? 0) + ((sample?.durationSec ?? 0) / 2), 3),
        file: sample?.files?.mid ?? null
      },
      EVIDENCE.MEASURED,
      'the video is a single continuous shot, so there is no clip to use as a reference. Feed this keyframe ' +
      'to an image-to-video model; a clip-based endpoint needs a multi-shot source'
    )
  }
  const noteParts = [`${shots.pilots.candidatesInRange} of ${shots.pilots.totalShots} detected shots are long enough for a 3-8 s generation clip`]
  if (shots.pilots.peakRegion !== null && shots.pilots.peakRegion !== undefined) {
    noteParts.push(`chosen from the highest-energy region ${shots.pilots.peakRegion.startSec}-${shots.pilots.peakRegion.endSec}s`)
  }
  if (shots.pilots.note !== undefined) noteParts.push(shots.pilots.note)
  return field(shots.pilots.pilots, EVIDENCE.MEASURED, noteParts.join('; '))
}

/** Genre, vibe and mood need a semantic model, which the local profile does not use. */
export function gradeSemantics(profile) {
  return field(
    null,
    EVIDENCE.UNVERIFIED,
    profile === 'local'
      ? 'the local profile makes no semantic call. Run the assisted or cloud profile for a native audio/video interpretation conditioned on the measured fields'
      : 'the semantic pass is a later stage and did not run for this pack'
  )
}

/** Per-shot semantic fields: measurable timing/pixels yes, interpretation no. */
export function gradeShot(shot, ocrAvailable, semanticShot, semanticContext = {}) {
  const mid = shot.palette?.mid ?? null
  const model = (value) => (typeof value === 'string' && value.length > 0
    ? field(value, EVIDENCE.INFERRED, 'described by the assisted semantic pass, conditioned on measured fields')
    : null)
  return {
    index: shot.index,
    detectedShot: shot.detectedShot ?? shot.index,
    startSec: field(shot.startSec, EVIDENCE.MEASURED),
    endSec: field(shot.endSec, EVIDENCE.MEASURED, 'scene-change boundary from ffmpeg scdet'),
    durationSec: field(shot.durationSec, EVIDENCE.MEASURED),
    frames: shot.frames.map((frame) => ({
      role: frame.role,
      atSec: field(frame.atSec, EVIDENCE.MEASURED),
      file: shot.files?.[frame.role] ?? null,
      palette: frame.role === 'mid'
        ? (mid === null
            ? field(null, EVIDENCE.UNVERIFIED, 'the frame could not be decoded for colour measurement')
            : field(mid, EVIDENCE.MEASURED, 'mean RGB, luma, saturation and dominant colours from 16x16 real pixels'))
        : undefined
    })),
    camera: model(semanticShot?.camera) ?? field(null, EVIDENCE.UNVERIFIED, 'camera movement needs a native video model; nothing in a frame statistic establishes it'),
    action: model(semanticShot?.action) ?? field(null, EVIDENCE.UNVERIFIED, 'action needs a native video model or the operator'),
    lighting: field(shot.palette?.mid === undefined || shot.palette?.mid === null ? null : shot.palette.mid, EVIDENCE.MEASURED,
      'only the measured luma and colour statistics are claimed here; the lighting *design* is not'),
    transition: model(semanticShot?.transition) ?? field(shot.transitionNote ?? null, EVIDENCE.UNVERIFIED, 'the cut is detected; whether it is a hard cut, a dissolve or a wipe is not measured'),
    ocr: model(semanticShot?.onScreenText) ?? (() => {
      // Three genuinely different situations, and the note must say which one:
      // the pass read this frame and saw no text; the pass ran but this frame was
      // not among the budgeted ones it saw; or no pass ran at all.
      if (semanticContext.readByPass === true) {
        return field(null, EVIDENCE.UNVERIFIED, 'the semantic pass was shown this frame and reported no on-screen text')
      }
      if (semanticContext.ran === true) {
        return field(null, EVIDENCE.UNVERIFIED, 'this shot was not among the keyframes sent to the semantic pass, and no OCR engine is installed')
      }
      return field(null, EVIDENCE.UNVERIFIED, ocrAvailable
        ? 'OCR ran but found no text in this frame'
        : 'no OCR engine is installed on this machine (tesseract is absent), and no semantic pass ran')
    })()
  }
}

/**
 * Assemble `replication.json`.
 * @param {object} input
 */
export function buildPack(input) {
  const { source, audio, shots, lyrics, mode, profile, artifacts, timings, ocrAvailable, chords, stems, semantic } = input
  const features = audio?.features ?? null
  const tempo = gradeTempo(features?.tempo ?? null)
  const key = gradeKey(features?.key ?? null)
  const cadence = gradeCadence(features?.cadence ?? null, features?.onsets ?? null, tempo)

  return {
    schema: 'dsh-media-reader/replication@1',
    generatedAt: new Date().toISOString(),
    mode,
    profile,
    source: {
      path: source.path,
      bytes: source.bytes,
      sha256: source.sha256 ?? null,
      container: source.container,
      durationSeconds: source.durationSeconds,
      bitRate: source.bitRate,
      video: source.video,
      audio: source.audio,
      evidence: EVIDENCE.MEASURED,
      note: 'ffprobe and sha256sum over the file itself; no model involved'
    },
    music: features === null
      ? field(null, EVIDENCE.UNVERIFIED, 'this file has no audio stream')
      : {
          tempo,
          key,
          cadence,
          loudness: gradeLoudness(source.loudness),
          // A silent or sub-second file never reaches the energy/timbre stage, so
          // these two must degrade to UNVERIFIED instead of throwing on undefined.
          energy: features.energy === undefined || features.energy === null
            ? field(null, EVIDENCE.UNVERIFIED, 'the worker could not measure energy for this audio')
            : field(
                {
                  rmsDb: features.energy.rmsDb,
                  peakDb: features.energy.peakDb,
                  dynamicRangeDb: features.energy.dynamicRangeDb
                },
                EVIDENCE.MEASURED,
                'RMS, sample peak and the 10th-to-95th percentile spread of frame loudness'
              ),
          timbre: features.timbre === undefined || features.timbre === null
            ? field(null, EVIDENCE.UNVERIFIED, 'the worker could not measure timbre for this audio')
            : field(
                {
                  harmonicPercussiveRatio: features.timbre.harmonicPercussiveRatio,
                  mfccMean: features.timbre.mfcc.mean,
                  mfccStd: features.timbre.mfcc.std
                },
                EVIDENCE.MEASURED,
                '13 MFCCs and a harmonic/percussive energy ratio from median filtering on a 48-band reduction — a ratio, not stems'
              ),
          sections: gradeSections(features.sections),
          chords: gradeChords(chords, key.value),
          instruments: semantic === null || semantic === undefined
            ? gradeInstruments()
            : field(
                semantic.fields.instruments.map((entry) => ({
                  name: entry.name,
                  role: entry.role,
                  confidence: entry.confidence
                })),
                EVIDENCE.INFERRED,
                'hypotheses from the assisted semantic pass, conditioned on the measured fields. They are not a measurement: no classifier ran'
              ),
          genreVibe: semantic === null || semantic === undefined
            ? gradeSemantics(profile)
            : field(
                { genre: semantic.fields.genre, vibe: semantic.fields.vibe, era: semantic.fields.era, mood: semantic.fields.mood },
                EVIDENCE.INFERRED,
                `interpretation from ${semantic.model}, not a measurement`
              ),
          semantic: gradeSemantic(semantic, profile),
          stems: gradeStems(stems, input.stemsError),
          onsets: features.onsets === undefined || features.onsets === null
            ? field(null, EVIDENCE.UNVERIFIED, 'no onsets were measurable in this audio')
            : field(
                { count: features.onsets.count, ratePerSec: features.onsets.ratePerSec },
                EVIDENCE.MEASURED,
                'loudness onsets: rises in total spectral energy. A quiet hi-hat over a constant bed may not register, which is why the beat grid and rate are reported too'
              ),
          analysisWindow: field(
            {
              audioSeconds: features.analysis.audioSeconds,
              fileDurationSeconds: source.durationSeconds,
              truncated: features.audio.truncated === true
            },
            EVIDENCE.MEASURED,
            features.audio.truncated === true
              ? 'ANALYSIS WAS TRUNCATED: fewer seconds were measured than the file contains'
              : 'the whole audio track was measured; no duration cap was applied'
          )
        },
    video: source.hasVideo !== true
      ? field(null, EVIDENCE.UNVERIFIED, 'this file has no video stream')
      : {
          shotCount: field(
            { detected: shots?.detected ?? 0, sampled: shots?.shots?.length ?? 0 },
            EVIDENCE.MEASURED,
            shots?.truncated === true
              ? `scene detection found ${shots.detected} shots; ${shots.shots.length} were sampled evenly across the video because of the shot budget`
              : 'every detected shot was sampled'
          ),
          inventory: gradeShotInventory(shots),
          pilotShots: gradePilotShots(shots),
          shots: (shots?.shots ?? []).map((shot) => {
            const semanticShot = (semantic?.fields?.shots ?? [])
              .find((entry) => entry.detectedShot === shot.detectedShot)
            const readByPass = semantic?.mediaItems === undefined || semantic?.mediaItems === null
              ? semanticShot !== undefined
              : semantic.mediaItems.some((item) => item.detectedShot === shot.detectedShot)
            return gradeShot(shot, ocrAvailable, semanticShot, {
              ran: semantic !== null && semantic !== undefined,
              readByPass
            })
          }),
          semantics: gradeSemantics(profile)
        },
    lyrics: gradeLyrics(lyrics ?? null),
    skipped: input.skipped ?? [],
    unmeasured: features?.unmeasured ?? {},
    artifacts,
    timings,
    rights: input.rights ?? {
      confirmedByOperator: true,
      note: 'the operator confirmed rights to use this source for testing and for derived artifacts'
    }
  }
}

/**
 * `plan.json` — what a generation job may preserve and what it must not regress.
 * Deliberately mechanical: it lists the fields that were measured and leaves the
 * intended change to the operator instead of inventing one.
 */
export function buildPlan(pack) {
  const measured = []
  const inferred = []
  const walk = (node, prefix) => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) return
    if (typeof node.evidence === 'string') {
      if (node.value === null) return
      if (node.evidence === EVIDENCE.MEASURED) measured.push(prefix)
      // An INFERRED field is still a measurement: a generated take should be
      // evaluated against it, with the uncertainty carried along instead of the
      // field being dropped from the plan entirely.
      else if (node.evidence === EVIDENCE.INFERRED) inferred.push(prefix)
      return
    }
    for (const [key, value] of Object.entries(node)) walk(value, prefix === '' ? key : `${prefix}.${key}`)
  }
  walk(pack, '')
  return {
    schema: 'dsh-media-reader/plan@1',
    generatedAt: pack.generatedAt,
    mode: pack.mode,
    profile: pack.profile,
    preserve: measured,
    preserveWithCaution: inferred,
    preserveNote: 'preserve is measured; preserveWithCaution is measured but not decisive — evaluate a take against both, and do not treat the cautious ones as ground truth',
    change: [],
    changeNote: 'v1 does not invent a transformation. The operator states what must change (for example: characters become anime-styled) and it is recorded here before any generation call',
    evaluation: pack.mode === 'replica'
      ? ['tempo within 2 BPM', 'key identical or a declared relative', 'section boundaries within 1 s', 'shot timing and order preserved', 'energy and loudness within 1 dB']
      : ['shot order and timing preserved', 'section boundaries preserved', 'storyline and action preserved per shot', 'tempo and key preserved if the arrangement is meant to stay'],
    generation: null,
    generationNote: 'no generation call was made. The Kie adapter is the next build step'
  }
}
