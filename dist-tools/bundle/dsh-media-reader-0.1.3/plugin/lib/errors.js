/**
 * Typed failures for the media reader.
 *
 * Every failure names a stable code and a model-facing message. The tools never
 * return an empty result to stand in for a missing dependency or a file that
 * could not be decoded.
 */
export class MediaError extends Error {
  constructor(code, message, details = undefined) {
    super(message)
    this.name = 'MediaError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

export function fail(code, message, details) {
  throw new MediaError(code, message, details)
}
