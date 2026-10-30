/**
 * One tiny process seam shared by the CLI and (later) the plugin.
 *
 * The evidence pack must run without a DSH server — that is what makes it
 * testable before any restart. So the core takes a `run` function instead of a
 * context object, and both callers supply one:
 *
 * - `createNodeRunner()` for the CLI (child_process, no shell, capped output);
 * - `createPluginRunner(ctx)` for a tool, through the harness subprocess seam.
 *
 * Both return `{ stdout, stderr, exitCode }` and both kill the process on
 * timeout or abort. Neither ever builds a shell string.
 */
import { spawn } from 'node:child_process'

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const KILL_GRACE_MS = 1_000

function collect(stream, cap) {
  const chunks = []
  let bytes = 0
  let truncated = false
  stream.on('data', (chunk) => {
    bytes += chunk.length
    if (bytes <= cap) {
      chunks.push(chunk)
      return
    }
    // Keep the tail: diagnostics live at the end of ffmpeg output.
    truncated = true
    chunks.push(chunk)
    while (bytes > cap && chunks.length > 1) bytes -= chunks.shift().length
  })
  return () => ({
    text: Buffer.concat(chunks).toString('utf8'),
    bytes,
    truncated
  })
}

/** A runner over node's child_process. */
export function createNodeRunner() {
  return function run(argv, options = {}) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
    return new Promise((resolve, reject) => {
      if (!Array.isArray(argv) || argv.length === 0) {
        reject(new Error('run requires a non-empty argv array'))
        return
      }
      let child
      try {
        child = spawn(argv[0], argv.slice(1), {
          cwd: options.cwd,
          stdio: ['ignore', 'pipe', 'pipe'],
          signal: options.signal
        })
      } catch (error) {
        reject(new Error(`could not start ${argv[0]}: ${error.message}`))
        return
      }
      const readOut = collect(child.stdout, maxOutputBytes)
      const readErr = collect(child.stderr, maxOutputBytes)
      let timedOut = false
      let settled = false
      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGKILL')
      }, timeoutMs)
      const finish = (exitCode, spawnError) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        const stdout = readOut()
        const stderr = readErr()
        if (timedOut) {
          const error = new Error(`${argv[0]} did not finish within ${timeoutMs} ms`)
          error.code = 'TIMEOUT'
          error.stderr = stderr.text.slice(-2000)
          reject(error)
          return
        }
        if (spawnError !== undefined) {
          const error = new Error(`could not start ${argv[0]}: ${spawnError.message}`)
          error.code = spawnError.code === 'ENOENT' ? 'SPAWN_FAILED' : 'PROCESS_FAILED'
          reject(error)
          return
        }
        resolve({ stdout: stdout.text, stderr: stderr.text, exitCode })
      }
      child.on('error', (error) => finish(null, error))
      child.on('close', (code) => finish(code))
    })
  }
}

/**
 * A runner over the harness subprocess service, for a plugin context.
 * @param {object} ctx plugin context with `subprocess` mounted
 */
export function createPluginRunner(ctx, runProcess) {
  return function run(argv, options = {}) {
    return runProcess(ctx, argv, {
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      signal: options.signal,
      maxOutputBytes: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
    })
  }
}

export const KILL_GRACE = KILL_GRACE_MS
