/**
 * Source facts: what the file *is*, before anything is interpreted.
 *
 * Everything here comes from ffprobe/ffmpeg and from hashing the bytes. No model
 * is involved, so every field can be marked MEASURED without qualification.
 */
import { stat } from 'node:fs/promises'

/** Parse `ffprobe -of json` output into the facts the pack needs. */
export function parseProbeJson(text) {
  const parsed = JSON.parse(text)
  const streams = Array.isArray(parsed.streams) ? parsed.streams : []
  const video = streams.find((stream) => stream.codec_type === 'video')
  const audio = streams.find((stream) => stream.codec_type === 'audio')
  const format = parsed.format ?? {}
  const duration = Number(format.duration)
  const fps = parseFrameRate(video?.avg_frame_rate ?? video?.r_frame_rate)
  return {
    hasVideo: video !== undefined,
    hasAudio: audio !== undefined,
    durationSeconds: Number.isFinite(duration) ? round(duration, 3) : null,
    container: typeof format.format_name === 'string' ? format.format_name : null,
    bitRate: Number.isFinite(Number(format.bit_rate)) ? Number(format.bit_rate) : null,
    video: video === undefined
      ? null
      : {
          codec: video.codec_name ?? null,
          width: Number(video.width) || null,
          height: Number(video.height) || null,
          fps,
          frameCount: Number.isFinite(Number(video.nb_frames)) ? Number(video.nb_frames) : null,
          pixelFormat: video.pix_fmt ?? null
        },
    audio: audio === undefined
      ? null
      : {
          codec: audio.codec_name ?? null,
          sampleRate: Number(audio.sample_rate) || null,
          channels: Number(audio.channels) || null,
          bitRate: Number.isFinite(Number(audio.bit_rate)) ? Number(audio.bit_rate) : null
        }
  }
}

function parseFrameRate(value) {
  if (typeof value !== 'string') return null
  const [numerator, denominator] = value.split('/').map(Number)
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null
  const fps = numerator / denominator
  return Number.isFinite(fps) && fps > 0 ? round(fps, 3) : null
}

/**
 * EBU R128 loudness from ffmpeg's `ebur128` filter summary.
 * Reports the integrated programme loudness, the range and the true peak.
 */
export function parseLoudness(stderr) {
  const text = String(stderr)
  const integrated = [...text.matchAll(/I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/gu)].at(-1)
  const range = [...text.matchAll(/LRA:\s*(-?\d+(?:\.\d+)?)\s*LU/gu)].at(-1)
  const peak = [...text.matchAll(/Peak:\s*(-?\d+(?:\.\d+)?)\s*dBFS/gu)].at(-1)
  return {
    integratedLufs: integrated === undefined ? null : round(Number(integrated[1]), 2),
    loudnessRangeLu: range === undefined ? null : round(Number(range[1]), 2),
    truePeakDbfs: peak === undefined ? null : round(Number(peak[1]), 2)
  }
}

/** Silence windows from ffmpeg's `silencedetect` filter. */
export function parseSilence(stderr) {
  const text = String(stderr)
  const starts = [...text.matchAll(/silence_start:\s*(-?\d+(?:\.\d+)?)/gu)].map((match) => Number(match[1]))
  const ends = [...text.matchAll(/silence_end:\s*(-?\d+(?:\.\d+)?)/gu)].map((match) => Number(match[1]))
  const windows = []
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index]
    const end = ends[index]
    if (!Number.isFinite(start)) continue
    windows.push({
      startSec: round(start, 2),
      endSec: Number.isFinite(end) ? round(end, 2) : null,
      durationSec: Number.isFinite(end) ? round(Math.max(0, end - start), 2) : null
    })
  }
  return windows
}

/**
 * Read every source fact for one file.
 * @param {Function} run process runner
 * @param {string} filePath absolute path
 * @param {{timeoutMs?: number, hash?: boolean, loudness?: boolean, signal?: AbortSignal}} [options]
 */
export async function readSourceFacts(run, filePath, options = {}) {
  const timeoutMs = options.timeoutMs ?? 120_000
  const info = await stat(filePath)
  const probe = await run(
    [
      'ffprobe', '-v', 'error',
      '-show_entries',
      'format=duration,size,bit_rate,format_name:stream=index,codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,nb_frames,pix_fmt,sample_rate,channels,bit_rate',
      '-of', 'json',
      filePath
    ],
    { timeoutMs, signal: options.signal, maxOutputBytes: 1_000_000 }
  )
  if (probe.exitCode !== 0) {
    throw new Error(`ffprobe failed for ${filePath}: ${probe.stderr.trim().slice(-400)}`)
  }
  const facts = parseProbeJson(probe.stdout)
  const entry = { ...facts, path: filePath, bytes: info.size }

  if (options.hash !== false) {
    const hashed = await run(['sha256sum', filePath], {
      timeoutMs,
      signal: options.signal,
      maxOutputBytes: 4096
    })
    if (hashed.exitCode !== 0) throw new Error(`sha256sum failed for ${filePath}`)
    entry.sha256 = hashed.stdout.trim().split(/\s+/u)[0] ?? null
  }

  if (facts.hasAudio && options.loudness !== false) {
    // One decode, two filters: loudness and silence are both derived from the
    // same samples, and running them as separate ffmpeg passes decoded a 368 s
    // file twice (measured 49 s -> 19 s). The numbers are identical because both
    // filters see the same stream.
    const analysis = await run(
      [
        'ffmpeg', '-hide_banner', '-nostats', '-i', filePath,
        '-af', 'ebur128=peak=true,silencedetect=noise=-30dB:d=0.5',
        '-vn', '-f', 'null', '-'
      ],
      { timeoutMs: Math.max(timeoutMs, 900_000), signal: options.signal, maxOutputBytes: 4_000_000 }
    )
    if (analysis.exitCode !== 0) {
      throw new Error(`ffmpeg loudness/silence analysis failed: ${analysis.stderr.trim().slice(-400)}`)
    }
    entry.loudness = parseLoudness(analysis.stderr)
    entry.silenceWindows = parseSilence(analysis.stderr)
  } else {
    entry.loudness = null
    entry.silenceWindows = []
  }

  return entry
}

function round(value, digits) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}
