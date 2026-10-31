/**
 * Evidence pack v2 contracts: chords, pilot-clip selection, the semantic
 * validator, and the Kie client's refusal paths.
 *
 * Nothing here touches the network. The paid stages are verified in a live run;
 * what must be provable without spending a credit is that the local logic is
 * right and that a failure is named rather than silently empty.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chordTemplate, identifyChords, NOTE_NAMES, scoreChroma } from '../lib/evidence/chords.js'
import { EVIDENCE, buildPack, gradeChords, gradeSemantic, gradeStems, keyChordFit } from '../lib/evidence/pack.js'
import { planShotRanges, selectPilotShots } from '../lib/evidence/shots.js'
import { buildSemanticPrompt, normaliseSemantic, parseSemanticJson } from '../lib/evidence/semantic.js'
import { appendLedger, maskKey, resolveKieKey } from '../lib/kie/client.js'
import { extractStems, stemFileName } from '../lib/evidence/stems.js'

// ---------------------------------------------------------------- chords ------
function chromaOf(pitchClasses, weight = 1) {
  const chroma = new Array(12).fill(0)
  for (const pitch of pitchClasses) chroma[pitch % 12] = weight
  return chroma
}

test('chord templates and scoring identify a plain triad', () => {
  assert.deepEqual(chordTemplate(0, 'major'), [1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0])
  // A minor = A(9) C(0) E(4): the template marks indices 0, 4 and 9.
  assert.deepEqual(chordTemplate(9, 'minor'), [1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0])
  // C major = C(0) E(4) G(7); A minor = A(9) C(0) E(4).
  const cMajor = scoreChroma(chromaOf([0, 4, 7]))
  assert.equal(cMajor[0].label, 'C major')
  const aMinor = scoreChroma(chromaOf([9, 0, 4]))
  assert.equal(aMinor[0].label, 'A minor')
  // A chromatic smear must not produce a confident winner.
  const smear = scoreChroma(new Array(12).fill(1))
  assert.ok(smear[0].score < 0.2, `uniform chroma scored ${smear[0].score}`)
})

test('identifyChords returns timed segments and drops what it cannot call', () => {
  const hopSec = 0.5
  // 8 s of C major (16 frames), then 8 s of A minor, then 8 s of uniform smear.
  const frames = []
  for (let index = 0; index < 16; index += 1) frames.push(chromaOf([0, 4, 7]))
  for (let index = 0; index < 16; index += 1) frames.push(chromaOf([9, 0, 4]))
  for (let index = 0; index < 16; index += 1) frames.push(new Array(12).fill(1))
  const result = identifyChords(frames, hopSec, { windowSec: 4, minConfidence: 0.12 })
  const labels = result.segments.map((segment) => segment.chord)
  assert.deepEqual(labels.slice(0, 2), ['C major', 'A minor'])
  assert.equal(result.segments[0].startSec, 0)
  assert.ok(result.segments[0].endSec > 0)
  // The smear must not add a confident segment at the end.
  assert.ok(result.segments.length <= 3, `expected at most 3 segments, got ${result.segments.length}`)
  assert.ok(result.method.includes('triad'))

  const empty = identifyChords([], hopSec)
  assert.deepEqual(empty.segments, [])
  assert.match(empty.note, /no chroma/u)
})

test('gradeChords is INFERRED, never MEASURED, and UNVERIFIED when empty', () => {
  const graded = gradeChords({ segments: [{ startSec: 0, endSec: 4, chord: 'C major', confidence: 0.6 }], method: 'triads' })
  assert.equal(graded.evidence, EVIDENCE.INFERRED)
  assert.equal(gradeChords({ segments: [], note: 'nothing cleared' }).evidence, EVIDENCE.UNVERIFIED)
})

// ------------------------------------------------------------ pilot shots -----
test('selectPilotShots prefers continuous shots long enough to generate from', () => {
  const boundaries = [
    { detectedShot: 1, startSec: 0, endSec: 1.2, durationSec: 1.2 },
    { detectedShot: 2, startSec: 1.2, endSec: 2.4, durationSec: 1.2 },
    { detectedShot: 3, startSec: 2.4, endSec: 12.4, durationSec: 10 },
    { detectedShot: 4, startSec: 12.4, endSec: 17.4, durationSec: 5 }
  ]
  const picked = selectPilotShots(boundaries, { minSeconds: 3, maxSeconds: 8, count: 2 })
  assert.equal(picked.candidatesInRange, 2)
  assert.equal(picked.pilots.length, 2)
  for (const pilot of picked.pilots) {
    assert.ok(pilot.durationSec <= 8, `clip ${pilot.durationSec}s exceeds the 8s cap`)
    assert.ok(pilot.durationSec >= 3, `clip ${pilot.durationSec}s is below the 3s minimum`)
  }
  // The 10 s shot must be trimmed to a window, and say so.
  const long = picked.pilots.find((pilot) => pilot.detectedShot === 3)
  assert.equal(long.wholeShot, false)
  assert.equal(long.endSec - long.startSec, 8)
})

test('selectPilotShots prefers the measured main region over the longest shots', () => {
  const boundaries = [
    { detectedShot: 1, startSec: 0, endSec: 20, durationSec: 20 },
    { detectedShot: 2, startSec: 20, endSec: 31, durationSec: 11 },
    { detectedShot: 3, startSec: 60, endSec: 65, durationSec: 5 },
    { detectedShot: 4, startSec: 90, endSec: 96, durationSec: 6 },
    { detectedShot: 5, startSec: 120, endSec: 126, durationSec: 6 },
    { detectedShot: 6, startSec: 200, endSec: 230, durationSec: 30 }
  ]
  const regions = [
    { startSec: 0, endSec: 40, energyDb: -30 },
    { startSec: 40, endSec: 180, energyDb: -12 },
    { startSec: 180, endSec: 230, energyDb: -26 }
  ]
  const picked = selectPilotShots(boundaries, { minSeconds: 3, maxSeconds: 8, count: 3, regions })
  assert.equal(picked.pickedFromPeakRegion, true)
  assert.deepEqual(picked.pilots.map((pilot) => pilot.detectedShot), [3, 4, 5])
  // The 20 s title card and the 30 s end card are excluded even though they are longer.
  assert.ok(!picked.pilots.some((pilot) => pilot.detectedShot === 1 || pilot.detectedShot === 6))
})

test('selectPilotShots reports honestly when nothing is long enough', () => {
  const boundaries = [
    { detectedShot: 1, startSec: 0, endSec: 0.9, durationSec: 0.9 },
    { detectedShot: 2, startSec: 0.9, endSec: 2.0, durationSec: 1.1 }
  ]
  const picked = selectPilotShots(boundaries, { minSeconds: 3, maxSeconds: 8 })
  assert.equal(picked.candidatesInRange, 0)
  assert.match(picked.note, /no continuous shot reached 3s/u)
})

test('the shot inventory carries every boundary, not only the sampled ones', () => {
  const cuts = Array.from({ length: 40 }, (_, index) => ({ timeSec: 1 + index * 1.5, score: 20 }))
  const plan = planShotRanges(cuts, 70, 5)
  assert.equal(plan.shots.length, 5, 'the frame budget still caps what is sampled')
  assert.equal(plan.boundaries.length, plan.detected, 'every detected shot is in the inventory')
  assert.ok(plan.boundaries.length > plan.shots.length)
})

// --------------------------------------------------------------- semantic -----
test('parseSemanticJson tolerates a code fence and refuses rubbish loudly', () => {
  assert.deepEqual(parseSemanticJson('{"a":1}'), { a: 1 })
  assert.deepEqual(parseSemanticJson('```json\n{"a":1}\n```'), { a: 1 })
  assert.throws(() => parseSemanticJson('I think the vibe is dark'), /SEMANTIC_NOT_JSON/u)
  assert.throws(() => parseSemanticJson(''), /SEMANTIC_EMPTY/u)
})

test('normaliseSemantic keeps only well-formed entries and never invents values', () => {
  const normalised = normaliseSemantic({
    genre: 'hip hop',
    vibe: null,
    instruments: [{ name: '808 bass', confidence: 1.7 }, { role: 'no name' }, 'junk'],
    vocal: { delivery: 'rapped', confidence: 0.8 },
    sections: [{ startSec: 0, endSec: 48, role: 'intro' }, { role: 'no times' }],
    chords: [{ chord: 'A minor', startSec: 0, endSec: 8, confidence: 0.4 }, { startSec: 1 }],
    shots: [{ mediaItem: 2, action: 'sitting in a car', camera: 'static' }, { index: 3, onScreenText: 'RICKYROZAY' }],
    cautions: ['tempo was not re-derived', '']
  })
  assert.equal(normalised.genre, 'hip hop')
  assert.equal(normalised.vibe, null)
  assert.equal(normalised.instruments.length, 1)
  assert.equal(normalised.instruments[0].confidence, 1, 'confidence is clamped to 0..1')
  assert.equal(normalised.sections.length, 1)
  assert.equal(normalised.chords.length, 1)
  assert.equal(normalised.shots.length, 2)
  assert.equal(normalised.shots[0].mediaItem, 2)
  assert.equal(normalised.shots[1].mediaItem, 3, 'index is accepted as the media-item position')
  // Mapping media item → detected shot happens against what was attached, never
  // from a shot number the model invented.
  assert.equal(normalised.shots[0].detectedShot, null)
  assert.deepEqual(normalised.cautions, ['tempo was not re-derived'])
})

test('buildSemanticPrompt carries the measured facts and forbids re-deriving them', () => {
  const prompt = buildSemanticPrompt({
    sourceName: 'v.mp4',
    durationSeconds: 368.078,
    tempo: { bpm: 158.27, confidence: 0.443, octaveAlternative: { bpm: 79.14 } },
    key: { tonic: 'A', mode: 'minor', correlation: 0.7167 },
    onsetRate: 1.91,
    loudnessLufs: -11.1,
    sections: [{ startSec: 0, endSec: 48, energyDb: -27.45 }],
    shots: [{ detectedShot: 1, startSec: 0, endSec: 27.277 }],
    mediaCount: 3,
    mediaItems: [
      { index: 1, describe: 'the full audio track', kind: 'audio' },
      { index: 2, describe: 'a keyframe of detected shot 74 (76.16-76.83s)', kind: 'image', detectedShot: 74 }
    ]
  })
  assert.match(prompt, /158\.27 BPM/u)
  assert.match(prompt, /79\.14/u)
  assert.match(prompt, /A minor/u)
  assert.match(prompt, /Do not restate the measured tempo or key as your own finding/u)
  assert.match(prompt, /media item 2: a keyframe of detected shot 74/u)
  assert.match(prompt, /"cautions"/u)
})

test('gradeSemantic is INFERRED when it ran and UNVERIFIED with a reason when it did not', () => {
  const ran = gradeSemantic({
    provider: 'kie', model: 'gemini-3-pro', latencyMs: 1200, mediaCount: 2,
    fields: { genre: 'hip hop', instruments: [{ name: '808 bass' }], shots: [], sections: [], chords: [] }
  }, 'assisted')
  assert.equal(ran.evidence, EVIDENCE.INFERRED)
  assert.match(ran.note, /not a measurement/u)
  const skipped = gradeSemantic(null, 'local')
  assert.equal(skipped.evidence, EVIDENCE.UNVERIFIED)
  assert.match(skipped.note, /local profile/u)
})

test('gradeStems is MEASURED for the files and states the separation is an approximation', () => {
  const graded = gradeStems({
    provider: 'kie', model: 'ai-music-api/separate-vocals', taskId: 't1', creditsSpent: 12,
    stems: [{ label: 'Drums', path: '/tmp/01-drums.mp3', bytes: 1000, measured: { tempo: 158.3 } }]
  })
  assert.equal(graded.evidence, EVIDENCE.MEASURED)
  assert.equal(graded.value.stems.length, 1)
  assert.match(graded.note, /approximation/u)
  assert.equal(gradeStems(null).evidence, EVIDENCE.UNVERIFIED)
})

test('pack v2 carries inventory, pilots, chords, stems and the semantic block', () => {
  const pack = buildPack({
    source: {
      hasVideo: true, hasAudio: true, path: '/tmp/x.mp4', bytes: 1, sha256: 'aa', container: 'mp4',
      durationSeconds: 100, bitRate: 1,
      video: { codec: 'h264', width: 1280, height: 720, fps: 24 },
      audio: { codec: 'aac', sampleRate: 44100, channels: 2 },
      loudness: { integratedLufs: -11, loudnessRangeLu: 9, truePeakDbfs: 1 }, silenceWindows: []
    },
    audio: {
      features: {
        audio: { durationSec: 100, truncated: false },
        tempo: { bpm: 120, confidence: 0.8, ambiguous: false, octaveAlternative: null, candidates: [] },
        key: { tonic: 'A', mode: 'minor', correlation: 0.8, margin: 0.2, alternatives: [] },
        cadence: { ioiMedianSec: 0.3 },
        onsets: { count: 100, ratePerSec: 1 },
        energy: { rmsDb: -12, peakDb: 0, dynamicRangeDb: 10 },
        timbre: { harmonicPercussiveRatio: 0.5, mfcc: { mean: [1], std: [0.1] } },
        sections: [{ index: 1, startSec: 0, endSec: 100, energyDb: -12, topPitchClasses: ['A'] }],
        analysis: { audioSeconds: 100, coverage: 1, elapsedMs: 1 },
        unmeasured: {}
      }
    },
    shots: {
      detected: 2, truncated: false, cuts: 1,
      boundaries: [
        { detectedShot: 1, startSec: 0, endSec: 3, durationSec: 3 },
        { detectedShot: 2, startSec: 3, endSec: 100, durationSec: 97 }
      ],
      pilots: { pilots: [{ detectedShot: 2, startSec: 3, endSec: 11, durationSec: 8, wholeShot: false }], candidatesInRange: 2, totalShots: 2 },
      shots: [{ index: 1, detectedShot: 2, startSec: 3, endSec: 11, durationSec: 8, frames: [{ role: 'mid', atSec: 7 }], files: { mid: '/tmp/f.png' }, palette: { mid: { meanLuma: 10, dominant: [] } } }]
    },
    lyrics: null,
    chords: { segments: [{ startSec: 0, endSec: 8, chord: 'A minor', confidence: 0.5 }], method: 'triads' },
    stems: { provider: 'kie', model: 'm', taskId: 't', stems: [{ label: 'Drums', path: '/tmp/d.mp3', bytes: 10, measured: {} }] },
    semantic: {
      provider: 'kie', model: 'gemini-3-pro', latencyMs: 900, mediaCount: 2,
      fields: {
        genre: 'hip hop', vibe: 'dark', era: null, mood: null,
        instruments: [{ name: '808 bass', role: 'low end', confidence: 0.7 }],
        vocal: null, sections: [], chords: [],
        shots: [{ detectedShot: 2, action: 'seated on a car', camera: 'static', lighting: null, transition: null, onScreenText: null, confidence: 0.6 }],
        mix: null, cautions: []
      }
    },
    mode: 'replica', profile: 'assisted',
    artifacts: { jobDir: '/tmp/job' }, timings: {}, skipped: [], ocrAvailable: false
  })
  assert.equal(pack.music.chords.evidence, EVIDENCE.INFERRED)
  assert.equal(pack.music.stems.evidence, EVIDENCE.MEASURED)
  assert.equal(pack.music.semantic.evidence, EVIDENCE.INFERRED)
  assert.equal(pack.music.instruments.evidence, EVIDENCE.INFERRED)
  assert.equal(pack.video.inventory.value.detected, 2)
  assert.equal(pack.video.pilotShots.value.length, 1)
  const shot = pack.video.shots[0]
  assert.equal(shot.action.evidence, EVIDENCE.INFERRED, 'a described action is INFERRED, never MEASURED')
  assert.match(shot.action.value, /seated/u)
  assert.equal(shot.camera.evidence, EVIDENCE.INFERRED)
  assert.equal(shot.ocr.evidence, EVIDENCE.UNVERIFIED, 'no on-screen text was returned, so it stays unclaimed')
})

// ------------------------------------------------------------------- kie ------
test('resolveKieKey reads KIE_AI_API_KEY from a file and names the wrong variable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kie-key-'))
  try {
    const good = join(dir, 'good.env')
    await import('node:fs/promises').then(({ writeFile }) => writeFile(good, 'KIE_AI_API_KEY="secret-value"\n'))
    assert.equal(await resolveKieKey({ envFile: good }), 'secret-value')
    const wrong = join(dir, 'wrong.env')
    await import('node:fs/promises').then(({ writeFile }) => writeFile(wrong, 'SOME_OTHER_KEY=1\n'))
    await assert.rejects(resolveKieKey({ envFile: wrong }), /KIE_AI_API_KEY, not KIE_API_KEY/u)
    await assert.rejects(resolveKieKey({ envFile: join(dir, 'absent.env') }), /KIE_KEY_FILE_MISSING/u)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('maskKey reveals shape only', () => {
  assert.equal(maskKey(''), '(none)')
  const masked = maskKey('abcdefghijkl')
  assert.ok(!masked.includes('abcdefghijkl'))
  assert.match(masked, /12 chars/u)
})

test('the ledger row carries no credential', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kie-ledger-'))
  try {
    const path = join(dir, 'kie-jobs.jsonl')
    await appendLedger(path, { kind: 'stem-separation', taskId: 't1', key: 'super-secret-key' })
    const text = await readFile(path, 'utf8')
    assert.ok(!text.includes('super-secret-key'), 'the credential must never be written to the ledger')
    const row = JSON.parse(text.trim())
    assert.equal(row.taskId, 't1')
    assert.equal(row.key, undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('extractStems reads the Suno response fields and their fallback list', () => {
  const stems = extractStems({
    vocalUrl: 'https://x/vocals.mp3',
    drumsUrl: 'https://x/drums.mp3',
    bassUrl: null,
    pianoUrl: null,
    originData: [
      { audio_url: 'https://x/vocals.mp3', stem_type_group_name: 'Vocals', duration: 300 },
      { audio_url: 'https://x/keys.mp3', stem_type_group_name: 'Keyboard', duration: 300 }
    ]
  })
  const labels = stems.map((stem) => stem.label)
  assert.deepEqual(labels, ['Vocals', 'Drums', 'Keyboard'])
  assert.equal(stemFileName('Backing Vocals', 3), '04-backing-vocals.mp3')
  assert.deepEqual(extractStems(null), [])
  assert.deepEqual(extractStems({ vocalUrl: 'not-a-url' }), [])
})

test('note names are the canonical twelve', () => {
  assert.equal(NOTE_NAMES.length, 12)
  assert.equal(NOTE_NAMES[9], 'A')
})

test('keyChordFit corroborates the key with the chord reading, and says nothing without a key', () => {
  // E major's diatonic triads: I, ii, vi, IV, V. (B MINOR is not among them —
  // the v is B major — which is exactly the kind of confusion this check exists
  // to expose.)
  const diatonic = [{ chord: 'E major' }, { chord: 'F# minor' }, { chord: 'C# minor' }, { chord: 'A major' }, { chord: 'B major' }]
  const fit = keyChordFit(diatonic, 'E major')
  assert.deepEqual(fit, { fitting: 5, total: 5, ratio: 1 })
  // A minor triad in E major is NOT diatonic; the check must notice.
  assert.equal(keyChordFit([{ chord: 'B minor' }, { chord: 'B major' }], 'E major').fitting, 1)
  const mixed = [{ chord: 'E major' }, { chord: 'F major' }]
  assert.equal(keyChordFit(mixed, 'E major').fitting, 1)
  assert.equal(keyChordFit(diatonic, null), null)
  assert.equal(keyChordFit([], 'E major'), null)
})

test('a single-shot video is told to use its keyframe, not a clip pilot', () => {
  const pack = buildPack({
    source: {
      hasVideo: true, hasAudio: true, path: '/tmp/x.mp4', bytes: 1, sha256: 'aa', container: 'mp4',
      durationSeconds: 700, bitRate: 1,
      video: { codec: 'h264', width: 1280, height: 720, fps: 30 }, audio: { codec: 'aac', sampleRate: 44100, channels: 2 },
      loudness: { integratedLufs: -14, loudnessRangeLu: 6, truePeakDbfs: -1 }, silenceWindows: []
    },
    audio: {
      features: {
        audio: { durationSec: 700, truncated: false },
        tempo: { bpm: 100.3, confidence: 0.5, ambiguous: false, octaveAlternative: null, candidates: [] },
        key: { tonic: 'E', mode: 'major', correlation: 0.64, margin: 0.089, alternatives: [] },
        cadence: { ioiMedianSec: 0.44 }, onsets: { count: 100, ratePerSec: 0.5 },
        energy: { rmsDb: -14, peakDb: 0, dynamicRangeDb: 10 },
        timbre: { harmonicPercussiveRatio: 0.7, mfcc: { mean: [1], std: [0.1] } },
        sections: [{ index: 1, startSec: 0, endSec: 700, energyDb: -14, topPitchClasses: ['E'] }],
        analysis: { audioSeconds: 700, coverage: 1, elapsedMs: 1 }, unmeasured: {}
      }
    },
    shots: {
      detected: 1, truncated: false, cuts: 0,
      boundaries: [{ detectedShot: 1, startSec: 0, endSec: 700, durationSec: 700 }],
      pilots: { pilots: [{ detectedShot: 1, startSec: 0, endSec: 8, durationSec: 8, wholeShot: false }], candidatesInRange: 1, totalShots: 1, peakRegion: { startSec: 0, endSec: 700, energyDb: -14 } },
      shots: [{ index: 1, detectedShot: 1, startSec: 0, endSec: 8, durationSec: 8, frames: [{ role: 'mid', atSec: 4 }], files: { mid: '/tmp/f.png' }, palette: { mid: { meanLuma: 40, dominant: [] } } }]
    },
    lyrics: null, chords: { segments: [{ startSec: 0, endSec: 8, chord: 'E major', confidence: 0.6 }], method: 'triads' },
    stems: null, semantic: null,
    mode: 'replica', profile: 'local', artifacts: { jobDir: '/tmp/job' }, timings: {}, skipped: [], ocrAvailable: false
  })
  assert.match(pack.video.pilotShots.note, /single continuous shot/u)
  assert.match(pack.video.pilotShots.note, /image-to-video/u)
  assert.match(pack.music.chords.note, /1 of 1 segments fit the measured key/u)
})

test('the rendered shot table keeps a multi-line model answer on one row', async () => {
  const { buildPack, buildPlan } = await import('../lib/evidence/pack.js')
  const { renderReplicationMarkdown } = await import('../lib/evidence/render.js')
  const source = {
    hasVideo: true, hasAudio: false, path: '/tmp/x.mp4', bytes: 1, sha256: 'aa', container: 'mp4',
    durationSeconds: 60, bitRate: 1, video: { codec: 'h264', width: 1280, height: 720, fps: 30 },
    audio: null, loudness: null, silenceWindows: []
  }
  const pack = buildPack({
    source,
    audio: null,
    shots: {
      detected: 1, truncated: false, cuts: 0,
      boundaries: [{ detectedShot: 1, startSec: 0, endSec: 60, durationSec: 60 }],
      pilots: { pilots: [{ detectedShot: 1, startSec: 0, endSec: 8, durationSec: 8, wholeShot: false }], candidatesInRange: 1, totalShots: 1, peakRegion: null },
      shots: [{ index: 1, detectedShot: 1, startSec: 0, endSec: 8, durationSec: 8, frames: [{ role: 'mid', atSec: 4 }], files: { mid: '/tmp/f.png' }, palette: { mid: { meanLuma: 10, dominant: [] } } }]
    },
    lyrics: null, chords: null, stems: null,
    semantic: {
      provider: 'kie', model: 'gemini-3-pro', latencyMs: 10, mediaCount: 2, audio: null,
      fields: {
        genre: null, vibe: null, era: null, mood: null, instruments: [], vocal: null,
        sections: [], chords: [], mix: null, cautions: [],
        shots: [{ mediaItem: 2, detectedShot: 1, action: 'static mountain', camera: 'wide',
          lighting: null, transition: 'none', onScreenText: 'Journey To The Stars\nSAVFK', confidence: 0.8 }]
      }
    },
    mode: 'replica', profile: 'assisted', artifacts: { jobDir: '/tmp/job' }, timings: {},
    skipped: [], ocrAvailable: false
  })
  const markdown = renderReplicationMarkdown({
    pack, plan: buildPlan(pack), jobDir: '/tmp/job', sourceName: 'x.mp4', timings: {}, skipped: [],
    artifacts: { referenceAudio: null, dspWav: null }
  })
  const row = markdown.split('\n').find((line) => line.startsWith('| 1 (1)'))
  assert.ok(row !== undefined, 'the shot row must exist')
  assert.match(row, /Journey To The Stars \/ SAVFK/u, 'the newline must be folded, not break the table')
  assert.match(row, /Static wide shot|wide \*\*INFERRED\*\*/u)
  assert.doesNotMatch(row, /\n/u)
})
