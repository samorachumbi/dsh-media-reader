import test from 'node:test'
import assert from 'node:assert/strict'
import { formatTimestamp, kindFromPath, parseProbe, parseRate } from '../lib/probe.js'

test('kindFromPath classifies every supported family and rejects unknown extensions', () => {
  assert.equal(kindFromPath('/tmp/a.PNG'), 'image')
  assert.equal(kindFromPath('/tmp/a.webp'), 'image')
  assert.equal(kindFromPath('/tmp/a.mp4'), 'video')
  assert.equal(kindFromPath('/tmp/a.MKV'), 'video')
  assert.equal(kindFromPath('/tmp/a.wav'), 'audio')
  assert.equal(kindFromPath('/tmp/a.mp3'), 'audio')
  assert.equal(kindFromPath('/tmp/a.txt'), undefined)
  assert.equal(kindFromPath('/tmp/a'), undefined)
})

test('parseRate turns ffprobe fractions into a number and refuses malformed rates', () => {
  assert.equal(parseRate('30000/1001'), 29.97)
  assert.equal(parseRate('25/1'), 25)
  assert.equal(parseRate('0/0'), undefined)
  assert.equal(parseRate('not-a-rate'), undefined)
  assert.equal(parseRate(undefined), undefined)
})

test('formatTimestamp is zero-padded and millisecond precise', () => {
  assert.equal(formatTimestamp(0), '00:00:00.000')
  assert.equal(formatTimestamp(12.4), '00:00:12.400')
  assert.equal(formatTimestamp(3725.5), '01:02:05.500')
  assert.equal(formatTimestamp(Number.NaN), '00:00:00.000')
})

test('parseProbe keeps the real stream facts and computes the media kind', () => {
  const document = {
    format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '6.000000', size: '375065' },
    streams: [
      { codec_type: 'video', codec_name: 'h264', width: 640, height: 360, avg_frame_rate: '10/1', nb_frames: '60' },
      { codec_type: 'audio', codec_name: 'aac', sample_rate: '44100', channels: 2 },
      { codec_type: 'subtitle', codec_name: 'mov_text' }
    ]
  }
  const info = parseProbe(document, { displayPath: '/fixtures/sample.mp4' })
  assert.equal(info.kind, 'video')
  assert.equal(info.durationSeconds, 6)
  assert.equal(info.image.width, 640)
  assert.equal(info.image.fps, 10)
  assert.equal(info.audioTracks, 1)
  assert.equal(info.audio[0].sampleRate, 44100)
  assert.equal(info.subtitleTracks, 1)
  assert.equal(info.sizeBytes, 375065)
})

test('parseProbe reports a video with no audio track as having zero tracks, not as audio', () => {
  const info = parseProbe(
    {
      format: { format_name: 'matroska,webm', duration: '2.0' },
      streams: [{ codec_type: 'video', codec_name: 'vp9', width: 320, height: 180 }]
    },
    { displayPath: '/fixtures/silent.webm' }
  )
  assert.equal(info.kind, 'video')
  assert.equal(info.audioTracks, 0)
  assert.deepEqual(info.audio, [])
})

test('parseProbe rejects a non-object document instead of inventing metadata', () => {
  assert.throws(() => parseProbe(null, { displayPath: '/x.png' }), /no JSON document/u)
  assert.throws(() => parseProbe('nope', { displayPath: '/x.png' }), /no JSON document/u)
})
