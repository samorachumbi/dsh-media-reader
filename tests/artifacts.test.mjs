import test from 'node:test'
import assert from 'node:assert/strict'
import { srtTimestamp, toReadableTranscript, toSrt, withMediaLock } from '../lib/artifacts.js'

test('srtTimestamp formats milliseconds with a comma', () => {
  assert.equal(srtTimestamp(0), '00:00:00,000')
  assert.equal(srtTimestamp(1.234), '00:00:01,234')
  assert.equal(srtTimestamp(3725.5), '01:02:05,500')
  assert.equal(srtTimestamp(Number.NaN), '00:00:00,000')
})

test('toSrt numbers segments and preserves text', () => {
  const srt = toSrt([
    { start: 0.5, end: 1.5, text: 'hello' },
    { start: 1.5, end: 2.5, text: 'world' }
  ])
  assert.match(srt, /^1\n00:00:00,500 --> 00:00:01,500\nhello$/mu)
  assert.match(srt, /^2\n00:00:01,500 --> 00:00:02,500\nworld$/mu)
})

test('toReadableTranscript keeps timestamps beside each line', () => {
  assert.equal(
    toReadableTranscript([{ start: 2, end: 3, text: 'spoken words' }]),
    '[00:00:02,000] spoken words'
  )
})

test('withMediaLock serializes jobs and survives a rejection', async () => {
  const order = []
  const first = withMediaLock(async () => {
    order.push('first-start')
    await new Promise((resolve) => setTimeout(resolve, 20))
    order.push('first-end')
    return 1
  })
  const second = withMediaLock(async () => {
    order.push('second-start')
    return 2
  })
  assert.deepEqual(await Promise.all([first, second]), [1, 2])
  assert.deepEqual(order, ['first-start', 'first-end', 'second-start'])

  await assert.rejects(withMediaLock(async () => {
    throw new Error('boom')
  }), /boom/u)
  await assert.equal(await withMediaLock(async () => 'still-works'), 'still-works')
})
