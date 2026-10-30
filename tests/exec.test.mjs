import test from 'node:test'
import assert from 'node:assert/strict'
import { runProcess, runChecked } from '../lib/exec.js'

function fakeContext({ stdout = '', stderr = '', exitCode = 0, hang = false } = {}) {
  return {
    get(name) {
      if (name !== 'subprocess') return undefined
      return {
        spawn(spec) {
          let resolveDone
          const done = new Promise((resolve, reject) => {
            resolveDone = resolve
            if (spec.signal !== undefined) {
              spec.signal.addEventListener('abort', () => resolve({ exitCode: null, signal: 'SIGTERM' }), { once: true })
            }
            if (!hang) resolve({ exitCode, signal: null })
          })
          return {
            pid: 123,
            done,
            terminate() {},
            collected: {
              stdout: { readFrom: () => ({ text: stdout, nextOffset: stdout.length, lossy: false }) },
              stderr: { readFrom: () => ({ text: stderr, nextOffset: stderr.length, lossy: false }) }
            },
            resolveDone
          }
        }
      }
    }
  }
}

test('runProcess returns collected output and the exit code', async () => {
  const result = await runProcess(fakeContext({ stdout: 'ok\n', stderr: 'warn\n' }), ['ffprobe', '-version'])
  assert.deepEqual(result, { stdout: 'ok\n', stderr: 'warn\n', exitCode: 0, timedOut: false })
})

test('runChecked turns a non-zero exit into a named failure with the stderr tail', async () => {
  await assert.rejects(
    runChecked(fakeContext({ exitCode: 2, stderr: 'bad input' }), ['ffmpeg', '-i', 'x']),
    (error) => error.code === 'PROCESS_FAILED' && /bad input/u.test(error.message)
  )
})

test('runProcess reports a timeout instead of returning an empty success', async () => {
  await assert.rejects(
    runProcess(fakeContext({ hang: true }), ['ffmpeg', '-i', 'slow'], { timeoutMs: 15 }),
    (error) => error.code === 'TIMEOUT'
  )
})

test('runProcess refuses an argv that was not an array of strings', async () => {
  await assert.rejects(runProcess(fakeContext(), ['ffmpeg', 42]), /argv array of strings/u)
  await assert.rejects(runProcess(fakeContext(), []), /argv array of strings/u)
})

test('runProcess rejects an already-cancelled call before spawning', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(runProcess(fakeContext(), ['ffprobe'], { signal: controller.signal }), (error) => error.code === 'ABORTED')
})
