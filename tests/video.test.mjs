import test from 'node:test'
import assert from 'node:assert/strict'
import { frameScale, fuseTimeline, parseScdetOutput, planShots } from '../lib/video.js'

test('parseScdetOutput reads both scdet line shapes and deduplicates by time', () => {
  const text = [
    '[scdet @ 0x1] lavfi.scd.score: 27.693, lavfi.scd.time: 2',
    '[Parsed_metadata_1 @ 0x2] lavfi.scd.score=27.693',
    '[Parsed_metadata_1 @ 0x2] lavfi.scd.time=2',
    '[Parsed_metadata_1 @ 0x2] lavfi.scd.score=1.000',
    '[Parsed_metadata_1 @ 0x2] lavfi.scd.time=4.5'
  ].join('\n')
  assert.deepEqual(parseScdetOutput(text), [
    { timeSec: 2, score: 27.693 },
    { timeSec: 4.5, score: 1 }
  ])
})

test('parseScdetOutput returns nothing for output with no scene events', () => {
  assert.deepEqual(parseScdetOutput('frame= 10 fps=0.0'), [])
})

test('planShots samples uniformly when no cuts are detected', () => {
  const shots = planShots([], 20, 4)
  assert.equal(shots.length, 3)
  assert.equal(shots[0].start, 0)
  assert.equal(shots.at(-1).end, 20)
  for (const shot of shots) assert.ok(shot.at > shot.start && shot.at < shot.end)
})

test('planShots uses detected cuts and caps the sampled shots', () => {
  const shots = planShots([{ timeSec: 2 }, { timeSec: 4 }], 6, 4)
  assert.equal(shots.length, 3)
  assert.deepEqual(shots.map((shot) => [shot.start, shot.end]), [[0, 2], [2, 4], [4, 6]])

  const capped = planShots([{ timeSec: 1 }, { timeSec: 2 }, { timeSec: 3 }, { timeSec: 4 }, { timeSec: 5 }], 6, 2)
  assert.equal(capped.length, 2)
})

test('planShots never returns zero shots for a short file', () => {
  assert.equal(planShots([], 0.5, 4).length, 1)
  assert.equal(planShots([], undefined, 4).length, 1)
})

test('frameScale keeps frames inside the request budget and never upscales', () => {
  assert.deepEqual(frameScale(1920, 1080), { width: 800, height: 450 })
  assert.deepEqual(frameScale(1000, 1000), { width: 800, height: 800 })
  assert.deepEqual(frameScale(320, 180), { width: 320, height: 180 })
  assert.deepEqual(frameScale(4000, 3000), { width: 800, height: 600 })
  assert.equal(frameScale(0, 100), undefined)
})

test('fuseTimeline joins transcript segments to the shot window they overlap', () => {
  const shots = [
    { index: 1, start: 0, end: 2, at: 1 },
    { index: 2, start: 2, end: 4, at: 3 }
  ]
  const rows = fuseTimeline(shots, [
    { start: 0.5, end: 1.5, text: 'first words' },
    { start: 2.5, end: 3.5, text: 'second words' }
  ])
  assert.equal(rows[0].said, 'first words')
  assert.equal(rows[1].said, 'second words')
  assert.equal(rows[0].frame, 'shot-01.png')
})

test('fuseTimeline reports null speech rather than an empty string', () => {
  const rows = fuseTimeline([{ index: 1, start: 0, end: 2, at: 1 }], [])
  assert.equal(rows[0].said, null)
})
