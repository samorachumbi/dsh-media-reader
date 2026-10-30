import test from 'node:test'
import assert from 'node:assert/strict'
import { formatTimestamp, kindFromPath, parseProbe, parseRate } from '../lib/probe.js'
import { parseWorkerOutput } from '../lib/stt.js'

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

test('parseProbe does not present a still image as having a frame rate', () => {
  const info = parseProbe(
    {
      format: { format_name: 'png_pipe' },
      streams: [{ codec_type: 'video', codec_name: 'png', width: 640, height: 360, avg_frame_rate: '25/1' }]
    },
    { displayPath: '/fixtures/hello.png' }
  )
  assert.equal(info.kind, 'image')
  assert.equal(info.image.width, 640)
  assert.equal(info.image.fps, undefined)
})

test('parseProbe reports an audio-only file with a video extension as audio', () => {
  const info = parseProbe(
    {
      format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '3.0' },
      streams: [{ codec_type: 'audio', codec_name: 'aac', sample_rate: '16000', channels: 1 }]
    },
    { displayPath: '/fixtures/voice.mp4' }
  )
  assert.equal(info.kind, 'audio')
  assert.equal(info.image, undefined)
  assert.equal(info.audioTracks, 1)
})

test('parseProbe rejects a non-object document instead of inventing metadata', () => {
  assert.throws(() => parseProbe(null, { displayPath: '/x.png' }), /no JSON document/u)
  assert.throws(() => parseProbe('nope', { displayPath: '/x.png' }), /no JSON document/u)
})

test('parseWorkerOutput finds the marker line even when a library logs to stdout', () => {
  const stdout = [
    '{"level":"ERROR","fields":{"message":"xet logging failed"}}',
    'MEDIA_READER_RESULT {"ok":true,"segments":[],"text":""}',
    'WARNING: unauthenticated hub request'
  ].join('\n')
  assert.deepEqual(parseWorkerOutput(stdout), { ok: true, segments: [], text: '' })
})

test('parseWorkerOutput rejects empty output rather than inventing an empty transcript', () => {
  assert.throws(() => parseWorkerOutput('  \n'), /no output/u)
  assert.throws(() => parseWorkerOutput('not json'), /Unexpected token|not valid JSON/u)
})

test('the audio envelope reports the FILE duration, never the transcribed window', async () => {
  const { transcriptEnvelope } = await import('../lib/audio.js')
  const transcript = {
    model: 'base', computeType: 'int8', language: 'en', languageProbability: 0.97,
    duration: 300, text: 'x', realTimeFactor: 0.16, truncated: true,
    segments: [{ start: 0.5, end: 7.8, text: 'hello' }], artifacts: {}
  }
  const text = transcriptEnvelope('song.mp3', transcript, 368.013)
  // The defect: a 368.013 s MP3 reported `durationSeconds 300.00`.
  assert.match(text, /<durationSeconds>368\.01<\/durationSeconds>/u)
  assert.match(text, /<processedSeconds>300\.00<\/processedSeconds>/u)
  assert.match(text, /only the first 300\.0 of 368\.0 seconds were transcribed/u)
  // Without a known file duration it must still not invent one.
  const unknown = transcriptEnvelope('song.mp3', transcript)
  assert.match(unknown, /<durationSeconds>300\.00<\/durationSeconds>/u)
})
