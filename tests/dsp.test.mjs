/**
 * The DSP worker's own ground-truth checks, run through node --test so a change
 * to the Python cannot land without the suite noticing.
 *
 * This is deliberately not a "does it produce numbers" test: every assertion is a
 * property of a synthetic signal whose answer is known before the measurement.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROJECT = join(HERE, '..')
const PYTHON = process.env.DSH_MEDIA_STT_PYTHON ?? join(PROJECT, '.venv-stt', 'bin', 'python')
const WORKER = join(PROJECT, 'python', 'dsp_worker.py')
const MARKER = 'MEDIA_EVIDENCE_RESULT '

function runSelfTest() {
  if (!existsSync(PYTHON)) return { skipped: true, reason: `no interpreter at ${PYTHON}` }
  const result = spawnSync(PYTHON, [WORKER, '--self-test'], { encoding: 'utf8', timeout: 300_000 })
  const line = String(result.stdout ?? '').split('\n').find((entry) => entry.includes(MARKER))
  if (line === undefined) {
    throw new Error(`DSP self-test produced no result line. stderr: ${String(result.stderr).slice(-800)}`)
  }
  return { payload: JSON.parse(line.slice(line.indexOf(MARKER) + MARKER.length).trim()) }
}

const outcome = runSelfTest()

test('the DSP worker passes its synthetic ground-truth checks', { skip: outcome.skipped === true ? outcome.reason : false }, () => {
  const payload = outcome.payload
  assert.equal(payload.ok, true, `failed checks: ${JSON.stringify(payload.checks.filter((check) => !check.passed))}`)
  assert.equal(payload.failed, 0)
  // A vacuous pass is worse than no test: require the checks to have existed.
  assert.ok(payload.passed >= 9, `expected at least 9 checks, counted ${payload.passed}`)
})

test('every ground-truth check is individually named and reported', { skip: outcome.skipped === true ? outcome.reason : false }, () => {
  const names = outcome.payload.checks.map((check) => check.name)
  for (const required of [
    'moving average matches convolution',
    '120 BPM click track',
    '96 BPM with off-beat eighths',
    'steady 440 Hz tone has no rhythm',
    'C-E-G triad reads as C major',
    'silence claims nothing',
    'truncation is reported'
  ]) {
    assert.ok(names.includes(required), `missing check: ${required}`)
  }
})
