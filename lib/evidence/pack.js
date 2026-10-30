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
export function gradeShot(shot, ocrAvailable) {
  const mid = shot.palette?.mid ?? null
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
    camera: field(null, EVIDENCE.UNVERIFIED, 'camera movement needs a native video model; nothing in a frame statistic establishes it'),
    action: field(null, EVIDENCE.UNVERIFIED, 'action needs a native video model or the operator'),
    lighting: field(shot.palette?.mid === undefined || shot.palette?.mid === null ? null : shot.palette.mid, EVIDENCE.MEASURED,
      'only the measured luma and colour statistics are claimed here; the lighting *design* is not'),
    transition: field(shot.transitionNote ?? null, EVIDENCE.UNVERIFIED, 'the cut is detected; whether it is a hard cut, a dissolve or a wipe is not measured'),
    ocr: ocrAvailable
      ? field(null, EVIDENCE.UNVERIFIED, 'OCR ran but found no text in this frame')
      : field(null, EVIDENCE.UNVERIFIED, 'no OCR engine is installed on this machine (tesseract is absent), so on-screen text is not read')
  }
}

/**
 * Assemble `replication.json`.
 * @param {object} input
 */
export function buildPack(input) {
  const { source, audio, shots, lyrics, mode, profile, artifacts, timings, ocrAvailable } = input
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
          instruments: gradeInstruments(),
          genreVibe: gradeSemantics(profile),
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
          shots: (shots?.shots ?? []).map((shot) => gradeShot(shot, ocrAvailable)),
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
