/**
 * Resolve a model-supplied media path through the harness filesystem seam.
 *
 * Mirrors the built-in read tools: relative paths resolve against the calling
 * session's workspace, absence is reported as absence, and the returned process
 * path is what a subprocess may open.
 */
import { MediaError } from './errors.js'

/**
 * @param {object} ctx plugin context with an `fs` service
 * @param {object} exec tool execution carrying `agent` and `signal`
 * @param {string} requestedPath raw model-supplied path
 * @returns {Promise<{target: object, info: object, displayPath: string, processPath: string}>}
 */
export async function resolveMediaTarget(ctx, exec, requestedPath) {
  if (typeof requestedPath !== 'string' || requestedPath.trim().length === 0) {
    throw new MediaError('INVALID_PATH', 'path must be a non-empty string')
  }
  const cwd = exec.agent?.session?.header?.cwd
  const target = await ctx.fs.resolve(
    requestedPath,
    {
      ...(typeof cwd === 'string' ? { cwd } : {}),
      signal: exec.signal
    }
  )
  const info = await ctx.fs.stat(target, exec.signal)
  if (info === undefined) {
    throw new MediaError('NOT_FOUND', `cannot read "${target.displayPath}": not found`)
  }
  if (info.type !== 'file') {
    throw new MediaError('NOT_REGULAR_FILE', `cannot read "${target.displayPath}": not a regular file`)
  }
  return {
    target,
    info,
    displayPath: target.displayPath,
    processPath: ctx.fs.processPath(target)
  }
}
