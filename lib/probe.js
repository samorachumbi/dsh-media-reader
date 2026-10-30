/**
 * ffprobe metadata for images, audio and video.
 *
 * The probe makes no model call and never guesses: it returns what ffprobe
 * reported, plus the ext-derived media kind that decides which tool path runs.
 */
import { extname } from 'node:path'
import { MediaError } from './errors.js'
import { runChecked } from './exec.js'

export const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])
export const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv', '.webm', '.m4v', '.avi', '.mpeg', '.mpg'])
export const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.wma'])

const PROBE_TIMEOUT_MS = 30_000

/** Media kind implied by the file extension, or undefined when unknown. */
export function kindFromPath(filePath) {
  const extension = extname(filePath).toLowerCase()
  if (IMAGE_EXTENSIONS.has(extension)) return 'image'
  if (VIDEO_EXTENSIONS.has(extension)) return 'video'
  if (AUDIO_EXTENSIONS.has(extension)) return 'audio'
  return undefined
}

/** True for a well-formed extension this deployment claims to read. */
export function isSupportedMediaPath(filePath) {
  return kindFromPath(filePath) !== undefined
}

/** Convert an ffprobe rate such as "30000/1001" to a number, or undefined. */
export function parseRate(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined
  const [numerator, denominator] = value.split('/').map(Number)
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return undefined
  return Math.round((numerator / denominator) * 1000) / 1000
}

/** Seconds as HH:MM:SS.mmm, the form used in every timeline artifact. */
export function formatTimestamp(seconds) {
  const total = Number.isFinite(seconds) && seconds > 0 ? seconds : 0
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${secs.toFixed(3).padStart(6, '0')}`
}

/**
 * Normalize one ffprobe JSON document.
 * @param {object} document parsed `ffprobe -print_format json` output
 * @param {{displayPath: string, sizeBytes?: number, declaredKind?: string}} context
 */
export function parseProbe(document, context) {
  if (document === null || typeof document !== 'object') {
    throw new MediaError('PROBE_INVALID', 'ffprobe returned no JSON document')
  }
  const streams = Array.isArray(document.streams) ? document.streams : []
  const format = document.format ?? {}
  const videoStream = streams.find((stream) => stream.codec_type === 'video')
  const audioStreams = streams.filter((stream) => stream.codec_type === 'audio')
  const subtitleStreams = streams.filter((stream) => stream.codec_type === 'subtitle')
  const formatName = typeof format.format_name === 'string' ? format.format_name : ''
  const durationSeconds = Number.parseFloat(format.duration ?? videoStream?.duration)
  const declaredKind = context.declaredKind ?? kindFromPath(context.displayPath)

  let kind = declaredKind
  if (kind === undefined) {
    if (videoStream === undefined && audioStreams.length > 0) kind = 'audio'
    else if (videoStream !== undefined && /(image2|_pipe|gif|webp)/u.test(formatName)) kind = 'image'
    else if (videoStream !== undefined) kind = 'video'
    else kind = 'unknown'
  }

  return {
    path: context.displayPath,
    kind,
    sizeBytes: Number.isFinite(context.sizeBytes)
      ? context.sizeBytes
      : Number.isFinite(Number(format.size))
        ? Number(format.size)
        : undefined,
    format: formatName || undefined,
    durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : undefined,
    image: videoStream === undefined
      ? undefined
      : {
          codec: videoStream.codec_name,
          width: Number.isFinite(Number(videoStream.width)) ? Number(videoStream.width) : undefined,
          height: Number.isFinite(Number(videoStream.height)) ? Number(videoStream.height) : undefined,
          fps: parseRate(videoStream.avg_frame_rate) ?? parseRate(videoStream.r_frame_rate),
          frames: Number.isFinite(Number(videoStream.nb_frames)) ? Number(videoStream.nb_frames) : undefined
        },
    audioTracks: audioStreams.length,
    audio: audioStreams.map((stream) => ({
      codec: stream.codec_name,
      sampleRate: Number.isFinite(Number(stream.sample_rate)) ? Number(stream.sample_rate) : undefined,
      channels: Number.isFinite(Number(stream.channels)) ? Number(stream.channels) : undefined,
      language: stream.tags?.language
    })),
    subtitleTracks: subtitleStreams.length
  }
}

/**
 * Probe one already-resolved filesystem target.
 * @param {object} ctx plugin context with `fs` and `subprocess`
 * @param {object} target resolved FsTarget
 * @param {{signal?: AbortSignal, displayPath?: string, sizeBytes?: number}} [options]
 */
export async function probeTarget(ctx, target, options = {}) {
  const processPath = ctx.fs.processPath(target)
  if (typeof processPath !== 'string' || !processPath.startsWith('/')) {
    throw new MediaError('PROBE_PATH', 'the filesystem backend did not return an absolute process path')
  }
  const result = await runChecked(
    ctx,
    ['ffprobe', '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', processPath],
    { timeoutMs: PROBE_TIMEOUT_MS, signal: options.signal, maxOutputBytes: 1024 * 1024 }
  )
  let document
  try {
    document = JSON.parse(result.stdout)
  } catch (error) {
    throw new MediaError('PROBE_INVALID', `ffprobe returned unreadable JSON: ${error.message}`)
  }
  return parseProbe(document, {
    displayPath: options.displayPath ?? String(target.targetKey),
    sizeBytes: options.sizeBytes,
    declaredKind: kindFromPath(options.displayPath ?? String(target.targetKey))
  })
}
