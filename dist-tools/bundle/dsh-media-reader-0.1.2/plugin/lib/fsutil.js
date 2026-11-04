/**
 * Resolve a model-supplied media path through the harness filesystem seam.
 *
 * Mirrors the built-in read tools: relative paths resolve against the calling
 * session's workspace, absence is reported as absence, and the returned process
 * path is what a subprocess may open.
 *
 * One addition: the plugin prints artifact references relative to the artifacts
 * root (so a draft never carries an absolute host path), so a relative path that
 * is not in the workspace is retried under `artifactsDir`. The workspace is
 * always tried first, so an existing workspace file can never be shadowed.
 */
import { isAbsolute, join } from 'node:path'
import { MediaError } from './errors.js'

/**
 * @param {object} ctx plugin context with an `fs` service
 * @param {object} exec tool execution carrying `agent` and `signal`
 * @param {string} requestedPath raw model-supplied path
 * @param {{artifactsDir?: string}} [options] the artifacts root an artifact-relative path is resolved against
 * @returns {Promise<{target: object, info: object, displayPath: string, processPath: string}>}
 */
export async function resolveMediaTarget(ctx, exec, requestedPath, options = {}) {
  if (typeof requestedPath !== 'string' || requestedPath.trim().length === 0) {
    throw new MediaError('INVALID_PATH', 'path must be a non-empty string')
  }
  const cwd = exec.agent?.session?.header?.cwd
  const attempt = async (path) => {
    const target = await ctx.fs.resolve(
      path,
      {
        ...(typeof cwd === 'string' ? { cwd } : {}),
        signal: exec.signal
      }
    )
    return { target, info: await ctx.fs.stat(target, exec.signal) }
  }

  let resolved = await attempt(requestedPath)
  if (
    resolved.info === undefined &&
    !isAbsolute(requestedPath) &&
    typeof options.artifactsDir === 'string' &&
    options.artifactsDir.length > 0
  ) {
    // Not found where the model asked; try the root this plugin prints from.
    const fromArtifacts = await attempt(join(options.artifactsDir, requestedPath))
    if (fromArtifacts.info !== undefined) resolved = fromArtifacts
  }

  const { target, info } = resolved
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
