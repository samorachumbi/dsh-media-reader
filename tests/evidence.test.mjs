/**
 * Evidence-pack contracts: the parsers, the graders and the honesty rules.
 *
 * The graders decide what the document is allowed to claim, so they get the
 * strictest assertions here: a weak measurement must not be graded MEASURED, and
 * the fields most likely to be invented (instruments, camera, action) must never
 * be.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseDspOutput } from '../lib/evidence/audio.js'
import {
  EVIDENCE,
  buildPack,
  buildPlan,
  gradeCadence,
  gradeInstruments,
  gradeKey,
  gradeLyrics,
  gradeSemantics,
  gradeTempo
} from '../lib/evidence/pack.js'
import { planShotRanges } from '../lib/evidence/shots.js'
import { summarisePixels } from '../lib/evidence/shots.js'
import { jobNameFor } from '../lib/evidence/index.js'
import { parseLoudness, parseProbeJson, parseSilence } from '../lib/evidence/source.js'

test('parseDspOutput finds the marker line among library logging', () => {
  const stdout = [
    'some huggingface notice',
    'MEDIA_EVIDENCE_RESULT {"ok":true,"tempo":{"bpm":120}}'
  ].join('\n')
  assert.deepEqual(parseDspOutput(stdout), { ok: true, tempo: { bpm: 120 } })
  assert.throws(() => parseDspOutput(''), /no output/u)
})

test('parseProbeJson classifies video, audio and duration without inventing values', () => {
  const parsed = parseProbeJson(JSON.stringify({
    streams: [
      { codec_type: 'video', codec_name: 'h264', width: 1280, height: 720, avg_frame_rate: '24000/1001' },
      { codec_type: 'audio', codec_name: 'aac', sample_rate: '44100', channels: 2 }
    ],
    format: { duration: '368.078005', format_name: 'mov,mp4,m4a', bit_rate: '591759' }
  }))
  assert.equal(parsed.hasVideo, true)
  assert.equal(parsed.hasAudio, true)
  assert.equal(parsed.durationSeconds, 368.078)
  assert.equal(parsed.video.fps, 23.976)
  assert.equal(parsed.audio.sampleRate, 44100)
  const audioOnly = parseProbeJson(JSON.stringify({
    streams: [{ codec_type: 'audio', codec_name: 'aac', sample_rate: '22050', channels: 1 }],
    format: { duration: '3.5', format_name: 'mp4' }
  }))
  assert.equal(audioOnly.hasVideo, false)
  assert.equal(audioOnly.video, null)
})

test('parseLoudness and parseSilence read ffmpeg summaries, and report absence as null', () => {
  const loud = parseLoudness('  I:         -15.4 LUFS\n  LRA:         4.1 LU\n  Peak:       -2.1 dBFS')
  assert.deepEqual(loud, { integratedLufs: -15.4, loudnessRangeLu: 4.1, truePeakDbfs: -2.1 })
  assert.equal(parseLoudness('').integratedLufs, null)
  const silence = parseSilence('silence_start: 12.5\nsilence_end: 15.25 | silence_duration: 2.75\nsilence_start: 40')
  assert.deepEqual(silence, [
    { startSec: 12.5, endSec: 15.25, durationSec: 2.75 },
    { startSec: 40, endSec: null, durationSec: null }
  ])
})

test('planShotRanges caps the sample count and says when it truncated', () => {
  const cuts = [10, 20, 30, 40, 50].map((timeSec) => ({ timeSec, score: 20 }))
  const all = planShotRanges(cuts, 60, 100)
  assert.equal(all.shots.length, 6)
  assert.equal(all.truncated, false)
  const capped = planShotRanges(cuts, 60, 3)
  assert.equal(capped.shots.length, 3)
  assert.equal(capped.truncated, true)
  assert.equal(capped.detected, 6)
  // Three sample points per shot, inside the shot, in order.
  for (const shot of capped.shots) {
    assert.equal(shot.frames.length, 3)
    const [start, mid, end] = shot.frames.map((frame) => frame.atSec)
    assert.ok(start < mid && mid < end, `frames out of order in shot ${shot.index}`)
    assert.ok(start >= shot.startSec && end <= shot.endSec, `frame outside shot ${shot.index}`)
  }
})

test('summarisePixels measures luma, saturation and dominant colour from real bytes', () => {
  const white = summarisePixels(Buffer.alloc(16 * 16 * 3, 255))
  assert.deepEqual(white.meanRgb, [255, 255, 255])
  assert.ok(white.meanLuma > 250)
  assert.equal(white.meanSaturation, 0)
  assert.equal(white.dominant[0].hex, '#ffffff')
  const black = summarisePixels(Buffer.alloc(16 * 16 * 3, 0))
  assert.ok(black.meanLuma < 2)
  assert.equal(summarisePixels(Buffer.alloc(0)), null)
})

test('gradeTempo refuses to call an ambiguous or low-confidence reading measured', () => {
  assert.equal(gradeTempo(null).evidence, EVIDENCE.UNVERIFIED)
  const strong = gradeTempo({ bpm: 120.11, confidence: 0.87, ambiguous: false, octaveAlternative: null, candidates: [] })
  assert.equal(strong.evidence, EVIDENCE.MEASURED)
  assert.equal(strong.value, 120.11)
  const octave = gradeTempo({ bpm: 158.27, confidence: 0.9, ambiguous: false, octaveAlternative: { bpm: 79.14, relation: 'half', score: 0.07 }, candidates: [] })
  assert.notEqual(octave.evidence, EVIDENCE.MEASURED, 'an octave rival must not be graded MEASURED')
  assert.match(octave.note, /79\.14/u)
  const weak = gradeTempo({ bpm: 90.7, confidence: 0.07, ambiguous: false, octaveAlternative: null, candidates: [] })
  assert.equal(weak.evidence, EVIDENCE.UNVERIFIED)
})

test('gradeKey needs both a strong correlation and a clear margin', () => {
  assert.equal(gradeKey(null).evidence, EVIDENCE.UNVERIFIED)
  assert.equal(gradeKey({ tonic: 'A', mode: 'minor', correlation: 0.72, margin: 0.22 }).evidence, EVIDENCE.MEASURED)
  assert.equal(gradeKey({ tonic: 'A', mode: 'minor', correlation: 0.68, margin: 0.001 }).evidence, EVIDENCE.INFERRED)
  assert.equal(gradeKey({ tonic: 'A', mode: 'minor', correlation: 0.39, margin: 0.14 }).evidence, EVIDENCE.UNVERIFIED)
})

test('gradeCadence never outranks the tempo it is measured against', () => {
  const cadence = { ioiMedianSec: 0.29, dominantIoiSec: 0.3, beatAlternationRatio: 0.5, accentSpread4: 0.6 }
  const withWeakTempo = gradeCadence(cadence, { count: 25 }, { evidence: EVIDENCE.UNVERIFIED })
  // Accents and alternation are computed on the beat grid: if the tempo is not
  // measured, they cannot be either.
  assert.equal(withWeakTempo.evidence, EVIDENCE.UNVERIFIED)
  assert.doesNotMatch(withWeakTempo.note, /probably half the reported tempo/u)
  const withInferredTempo = gradeCadence(cadence, { count: 25 }, { evidence: EVIDENCE.INFERRED })
  assert.equal(withInferredTempo.evidence, EVIDENCE.INFERRED)
  const withStrongTempo = gradeCadence(cadence, { count: 25 }, { evidence: EVIDENCE.MEASURED })
  assert.equal(withStrongTempo.evidence, EVIDENCE.MEASURED)
  assert.match(withStrongTempo.note, /probably half the reported tempo/u)
  // Without any grid-derived value the onset statistics stand alone.
  const onsetsOnly = gradeCadence({ ioiMedianSec: 0.29 }, { count: 25 }, { evidence: EVIDENCE.UNVERIFIED })
  assert.equal(onsetsOnly.evidence, EVIDENCE.MEASURED)
})

test('instruments and semantics are never graded as measured', () => {
  assert.equal(gradeInstruments().evidence, EVIDENCE.UNVERIFIED)
  assert.equal(gradeInstruments().value, null)
  assert.equal(gradeSemantics('local').evidence, EVIDENCE.UNVERIFIED)
  assert.equal(gradeSemantics('assisted').evidence, EVIDENCE.UNVERIFIED)
  assert.match(gradeSemantics('local').note, /local profile/u)
})

test('gradeLyrics separates a speech transcript from a sung vocal', () => {
  const speech = gradeLyrics({
    transcript: { text: 'hello world', segments: [{}, {}], language: 'en' },
    confidence: { segments: 2, words: 2, meanAvgLogprob: -0.2, meanNoSpeechProb: 0.1, verdict: 'speech-like' }
  })
  assert.equal(speech.evidence, EVIDENCE.MEASURED)
  const sung = gradeLyrics({
    transcript: { text: 'mumbled bars', segments: [{}], language: 'en' },
    confidence: { segments: 1, words: 2, meanAvgLogprob: -1.4, meanNoSpeechProb: 0.7, verdict: 'sung-or-uncertain' }
  })
  assert.equal(sung.evidence, EVIDENCE.INFERRED)
  assert.match(sung.note, /approximation, not the lyric/u)
  const none = gradeLyrics({
    transcript: { text: '', segments: [], language: 'en' },
    confidence: { segments: 0, words: 0, meanAvgLogprob: null, meanNoSpeechProb: null, verdict: 'unverified' }
  })
  assert.equal(none.evidence, EVIDENCE.UNVERIFIED)
})

test('buildPack tags every leaf and buildPlan only preserves what was measured', () => {
  const pack = buildPack({
    source: {
      hasVideo: true, hasAudio: true,
      path: '/tmp/x.mp4', bytes: 1, sha256: 'abc', container: 'mp4', durationSeconds: 10,
      bitRate: 1, video: { codec: 'h264', width: 2, height: 2, fps: 25 }, audio: { codec: 'aac', sampleRate: 44100, channels: 2 },
      loudness: { integratedLufs: -14, loudnessRangeLu: 5, truePeakDbfs: -1 }, silenceWindows: []
    },
    audio: {
      features: {
        audio: { durationSec: 10, truncated: false },
        tempo: { bpm: 120, confidence: 0.9, ambiguous: false, octaveAlternative: null, candidates: [{ bpm: 120, score: 1 }] },
        key: { tonic: 'C', mode: 'major', correlation: 0.85, margin: 0.2, alternatives: [] },
        cadence: { ioiMedianSec: 0.5, dominantIoiSec: 0.5, accentSpread4: 0.1, beatAlternationRatio: 0.01 },
        onsets: { count: 20, ratePerSec: 2 },
        energy: { rmsDb: -12, peakDb: 0, dynamicRangeDb: 10 },
        timbre: { harmonicPercussiveRatio: 0.5, mfcc: { mean: [1], std: [0.1] } },
        sections: [{ index: 1, startSec: 0, endSec: 10, energyDb: -12, harmonicRatio: 0.5, topPitchClasses: ['C'] }],
        analysis: { audioSeconds: 10, coverage: 1, elapsedMs: 5 },
        unmeasured: {}
      }
    },
    shots: { detected: 1, truncated: false, shots: [{ index: 1, startSec: 0, endSec: 10, durationSec: 10, frames: [{ role: 'mid', atSec: 5 }], files: { mid: '/tmp/f.png' }, palette: { mid: { meanLuma: 10, dominant: [] } } }] },
    lyrics: null,
    mode: 'replica',
    profile: 'local',
    artifacts: { jobDir: '/tmp/job' },
    timings: { source: 1 },
    skipped: [],
    ocrAvailable: false
  })
  assert.equal(pack.schema, 'dsh-media-reader/replication@1')
  assert.equal(pack.music.tempo.evidence, EVIDENCE.MEASURED)
  assert.equal(pack.music.instruments.evidence, EVIDENCE.UNVERIFIED)
  assert.equal(pack.video.shots[0].camera.evidence, EVIDENCE.UNVERIFIED)
  assert.equal(pack.video.shots[0].lighting.evidence, EVIDENCE.MEASURED)
  assert.equal(pack.video.shots[0].ocr.evidence, EVIDENCE.UNVERIFIED)
  assert.equal(pack.lyrics.evidence, EVIDENCE.UNVERIFIED)

  const plan = buildPlan(pack)
  assert.equal(plan.generation, null)
  assert.deepEqual(plan.change, [])
  assert.ok(plan.preserve.includes('music.tempo'))
  assert.ok(plan.preserve.includes('source'), 'the source facts are one measured block, not per-field leaves')
  assert.ok(!plan.preserve.some((entry) => entry.includes('instruments')))
  assert.ok(Array.isArray(plan.preserveWithCaution))
  assert.ok(!plan.preserveWithCaution.some((entry) => entry.includes('instruments')), 'unverified fields never reach the plan')
  // An inferred field is still worth evaluating against, but it is not ground truth.
  const inferredTempo = buildPlan({ ...pack, music: { ...pack.music, tempo: { value: 158.27, evidence: EVIDENCE.INFERRED, note: 'octave rival' } } })
  assert.ok(inferredTempo.preserveWithCaution.includes('music.tempo'))
  assert.ok(!inferredTempo.preserve.includes('music.tempo'))
})

test('jobNameFor builds a safe directory name from an awkward filename', () => {
  // Deliberately generic: a test may not embed the operator's private media path
  // (the leak scan flags it, and a test is not a place for a real track name).
  const name = jobNameFor('/media/incoming/Album Artist - A LONG TRACK TITLE (OFFICIAL VIDEO).mp4', new Date('2026-10-31T00:20:00Z'))
  assert.match(name, /^album-artist-a-long-track-title-official-video-20261031-002000$/u)
  assert.equal(jobNameFor('/tmp/!!!.mp4', new Date('2026-10-31T00:20:00Z')), 'job-20261031-002000')
})
