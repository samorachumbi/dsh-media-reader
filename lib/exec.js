/**
 * Bounded subprocess execution through the harness subprocess seam.
 *
 * Rules this file owns:
 * - argv arrays only; no shell, no string interpolation;
 * - an explicit timeout merged with the caller's cancellation;
 * - collected output capped in memory, with the tail kept on overflow;
 * - the process tree is terminated through the seam, never by pid.
 */
import { MediaError } from './errors.js'

export const DEFAULT_TIMEOUT_MS = 60_000
export const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const GRACE_MS = 1_000

/**
 * Run one program and collect its output.
 * @param {object} ctx plugin context with a mounted `subprocess` service
 * @param {string[]} argv program and arguments, already absolute where a path is involved
 * @param {{cwd?: string, timeoutMs?: number, signal?: AbortSignal, maxOutputBytes?: number}} [options]
 * @returns {Promise<{stdout: string, stderr: string, exitCode: number|null, timedOut: boolean}>}
 */
export async function runProcess(ctx, argv, options = {}) {
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((part) => typeof part !== 'string')) {
    throw new MediaError('INVALID_ARGV', 'runProcess requires a non-empty argv array of strings')
  }
  const subprocess = ctx.get('subprocess')
  if (subprocess === undefined) {
    throw new MediaError('NO_SUBPROCESS', 'the harness subprocess service is not mounted')
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  const controller = new AbortController()
  let timedOut = false

  const onCallerAbort = () => controller.abort(options.signal?.reason)
  if (options.signal !== undefined) {
    if (options.signal.aborted) throw new MediaError('ABORTED', 'the call was cancelled')
    options.signal.addEventListener('abort', onCallerAbort, { once: true })
  }
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(new Error(`timed out after ${timeoutMs} ms`))
  }, timeoutMs)

  let handle
  try {
    handle = subprocess.spawn({
      argv,
      cwd: options.cwd ?? process.cwd(),
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: maxOutputBytes },
        stderr: { maxBytes: maxOutputBytes }
      },
      graceMs: GRACE_MS,
      signal: controller.signal
    })
  } catch (error) {
    clearTimeout(timer)
    if (options.signal !== undefined) options.signal.removeEventListener('abort', onCallerAbort)
    throw new MediaError('SPAWN_FAILED', `could not start ${argv[0]}: ${error.message}`)
  }

  try {
    const outcome = await handle.done
    const stdout = handle.collected.stdout?.readFrom(0).text ?? ''
    const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
    if (options.signal?.aborted) throw new MediaError('ABORTED', 'the call was cancelled')
    if (timedOut) {
      throw new MediaError('TIMEOUT', `${argv[0]} did not finish within ${timeoutMs} ms`, {
        stderr: stderr.slice(-2000)
      })
    }
    return { stdout, stderr, exitCode: outcome.exitCode, timedOut: false }
  } finally {
    clearTimeout(timer)
    if (options.signal !== undefined) options.signal.removeEventListener('abort', onCallerAbort)
  }
}

/** Run one program and require a zero exit code. */
export async function runChecked(ctx, argv, options = {}) {
  const result = await runProcess(ctx, argv, options)
  if (result.exitCode !== 0) {
    const tail = result.stderr.trim().slice(-400)
    throw new MediaError(
      'PROCESS_FAILED',
      `${argv[0]} exited with code ${result.exitCode}${tail.length > 0 ? `: ${tail}` : ''}`,
      { stderr: result.stderr.slice(-2000) }
    )
  }
  return result
}
