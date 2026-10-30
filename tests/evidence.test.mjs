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

test('formatEvidenceSummary groups claims by evidence strength and never puts a guess in MEASURED', async () => {
  const { formatEvidenceSummary } = await import('../lib/evidence/summary.js')
  const { buildPack, buildPlan } = await import('../lib/evidence/pack.js')
  const pack = buildPack({
    source: {
      hasVideo: true, hasAudio: true, path: '/tmp/x.mp4', bytes: 1, sha256: 'abcdef1234567890',
      container: 'mp4', durationSeconds: 368.078, bitRate: 1,
      video: { codec: 'h264', width: 1280, height: 720, fps: 23.97616 },
      audio: { codec: 'aac', sampleRate: 44100, channels: 2 },
      loudness: { integratedLufs: -11.1, loudnessRangeLu: 9.3, truePeakDbfs: 1.5 }, silenceWindows: []
    },
    audio: {
      features: {
        audio: { durationSec: 368.036, truncated: false },
        tempo: { bpm: 158.27, confidence: 0.443, ambiguous: false, octaveAlternative: { bpm: 79.14, relation: 'half', score: 0.073 }, candidates: [{ bpm: 159.8, score: 0.08 }] },
        key: { tonic: 'A', mode: 'minor', correlation: 0.7167, margin: 0.2156, alternatives: [] },
        cadence: { ioiMedianSec: 0.348, dominantIoiSec: 0.175, beatAlternationRatio: 0.046, accentSpread4: 0.077 },
        onsets: { count: 703, ratePerSec: 1.91 },
        energy: { rmsDb: -12.74, peakDb: 0, dynamicRangeDb: 23.37 },
        timbre: { harmonicPercussiveRatio: 0.483, mfcc: { mean: [1], std: [0.1] } },
        sections: [{ index: 1, startSec: 0, endSec: 48, energyDb: -27.45, harmonicRatio: 0.511, topPitchClasses: ['D'] }],
        analysis: { audioSeconds: 368.036, coverage: 1, elapsedMs: 6500 },
        unmeasured: {}
      }
    },
    shots: { detected: 196, truncated: true, shots: [] },
    lyrics: {
      transcript: { text: 'mumbled bars over a beat', segments: [{}], language: 'en' },
      confidence: { segments: 70, words: 692, meanAvgLogprob: -0.5203, meanNoSpeechProb: 0.5032, verdict: 'sung-or-uncertain' }
    },
    mode: 'replica', profile: 'local',
    artifacts: { jobDir: '/tmp/job' }, timings: { source: 1 },
    skipped: [{ stage: 'stems (Demucs)', reason: 'not installed' }],
    ocrAvailable: false
  })
  const text = formatEvidenceSummary({
    pack,
    plan: buildPlan(pack),
    paths: { replicationMd: '/tmp/job/REPLICATION.md', replicationJson: '/tmp/job/replication.json' }
  })
  const measuredBlock = text.slice(text.indexOf('MEASURED'), text.indexOf('INFERRED'))
  const inferredBlock = text.slice(text.indexOf('INFERRED'), text.indexOf('NOT CLAIMED'))
  assert.match(measuredBlock, /A minor/u, 'a strong key belongs in MEASURED')
  assert.doesNotMatch(measuredBlock, /158\.27/u, 'an INFERRED tempo must not appear in the MEASURED block')
  assert.match(inferredBlock, /158\.27/u)
  assert.match(inferredBlock, /79\.14/u, 'the octave rival must be named')
  // Lyrics are rendered in their own block, tagged with their own verdict.
  assert.match(text, /LYRICS: 692 words · verdict sung-or-uncertain/u)
  assert.match(text, /mean log-probability -0\.52  \[INFERRED\]/u)
  assert.match(text, /instruments: —/u)
  assert.match(text, /NOT RUN/u)
  assert.match(text, /no generation call was made/u)
  assert.match(text, /REPLICATION\.md/u)
})

test('every block contains only its own tag — UNVERIFIED never appears under INFERRED', async () => {
  const { formatEvidenceSummary } = await import('../lib/evidence/summary.js')
  const { buildPack, buildPlan } = await import('../lib/evidence/pack.js')
  // A speech clip: tempo and key are both UNVERIFIED, which is exactly the case
  // that printed "[UNVERIFIED]" inside the INFERRED heading before the fix.
  const pack = buildPack({
    source: {
      hasVideo: false, hasAudio: true, path: '/tmp/a.mp4', bytes: 1, sha256: 'aa', container: 'mp4',
      durationSeconds: 11, bitRate: 1, video: null,
      audio: { codec: 'aac', sampleRate: 16000, channels: 1 },
      loudness: { integratedLufs: -15.4, loudnessRangeLu: 4.1, truePeakDbfs: -2.1 }, silenceWindows: []
    },
    audio: {
      features: {
        audio: { durationSec: 11, truncated: false },
        tempo: { bpm: 90.72, confidence: 0.071, ambiguous: false, octaveAlternative: { bpm: 181.44, relation: 'double', score: 0.15 }, candidates: [] },
        key: { tonic: 'A', mode: 'minor', correlation: 0.3891, margin: 0.1416, alternatives: [] },
        cadence: { ioiMedianSec: 0.29, dominantIoiSec: 0.302, beatAlternationRatio: 0.354, accentSpread4: 0.608 },
        onsets: { count: 25, ratePerSec: 2.27 },
        energy: { rmsDb: -17, peakDb: 0, dynamicRangeDb: 30 },
        timbre: { harmonicPercussiveRatio: 0.493, mfcc: { mean: [1], std: [0.1] } },
        sections: [],
        analysis: { audioSeconds: 11, coverage: 1, elapsedMs: 1 },
        unmeasured: {}
      }
    },
    shots: null,
    lyrics: null,
    mode: 'replica', profile: 'local',
    artifacts: { jobDir: '/tmp/job' }, timings: { source: 1 },
    skipped: [], ocrAvailable: false
  })
  const text = formatEvidenceSummary({ pack, plan: buildPlan(pack), paths: { replicationMd: '/tmp/REPLICATION.md', replicationJson: '/tmp/r.json' } })
  // Slice to the NEXT present heading, not to a heading that may be absent:
  // text.indexOf returns -1 for a missing heading and slice(…, -1) silently
  // returns almost the whole document (which made the first version of this
  // test assert about the wrong block).
  const sectionOf = (heading, nextHeadings) => {
    const start = text.indexOf(heading)
    if (start < 0) return ''
    const ends = nextHeadings.map((next) => text.indexOf(next, start + heading.length)).filter((at) => at > start)
    return text.slice(start, ends.length === 0 ? undefined : Math.min(...ends))
  }
  const measuredBlock = sectionOf('MEASURED (computed', ['INFERRED (', 'NOT CLAIMED ('])
  const inferredBlock = sectionOf('INFERRED (', ['NOT CLAIMED ('])
  const notClaimedBlock = sectionOf('NOT CLAIMED (', ['coverage:'])
  assert.doesNotMatch(measuredBlock, /UNVERIFIED/u)
  assert.doesNotMatch(inferredBlock, /UNVERIFIED/u, 'UNVERIFIED must not be printed under the INFERRED heading')
  assert.match(notClaimedBlock, /tempo: 90.72 BPM  \[UNVERIFIED\]/u)
  assert.match(notClaimedBlock, /cadence: .*\[UNVERIFIED\]/u)
  // A weak key prints its estimate with the UNVERIFIED tag: the reading exists,
  // the claim does not. That distinction is the point.
  assert.match(notClaimedBlock, /key: A minor  \[UNVERIFIED\]/u)
})
