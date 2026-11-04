/**
 * Full-duration audio measurement.
 *
 * The plugin's `media_audio` tool caps transcription at 300 s on purpose (a 6
 * minute file would otherwise block a chat turn). An evidence pack cannot cap:
 * a truncated tempo or a half-read structure would poison every later generation
 * comparison. So this path decodes the whole file and runs the DSP worker over
 * all of it, and records the covered seconds so a truncation would be visible.
 */
import { rm } from 'node:fs/promises'
import { join } from 'node:path'

export const DSP_MARKER = 'MEDIA_EVIDENCE_RESULT '

/**
 * Extract the worker's JSON line. Library logging can share stdout, so the
 * marker is searched for rather than assumed to be the whole stream.
 * @param {string} stdout
 */
export function parseDspOutput(stdout) {
  const lines = String(stdout).split('\n')
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const at = lines[index].indexOf(DSP_MARKER)
    if (at >= 0) return JSON.parse(lines[index].slice(at + DSP_MARKER.length).trim())
  }
  const last = lines.map((line) => line.trim()).filter(Boolean).at(-1)
  if (last === undefined) throw new Error('DSP worker produced no output')
  return JSON.parse(last)
}

/**
 * Decode, then measure.
 * @param {Function} run process runner
 * @param {{filePath: string, dir: string, python: string, worker: string, timeoutMs?: number,
 *          maxSeconds?: number|null, keepReferenceAudio?: boolean, signal?: AbortSignal}} options
 */
export async function measureAudio(run, options) {
  const timeoutMs = options.timeoutMs ?? 900_000
  const referenceDir = join(options.dir, 'reference')
  const dspWav = join(referenceDir, 'audio-mono-22050.wav')
  const started = Date.now()

  const decode = await run(
    [
      'ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
      '-i', options.filePath,
      '-vn', '-ac', '1', '-ar', '22050', '-c:a', 'pcm_s16le',
      dspWav
    ],
    { timeoutMs, signal: options.signal, maxOutputBytes: 256 * 1024 }
  )
  if (decode.exitCode !== 0) {
    throw new Error(`ffmpeg could not decode the audio track: ${decode.stderr.trim().slice(-400)}`)
  }

  const referenceAudio = await writeReferenceAudio(run, options, referenceDir, timeoutMs)

  const workerArgs = [options.python, options.worker, '--audio', dspWav]
  if (Number.isFinite(options.maxSeconds) && options.maxSeconds > 0) {
    workerArgs.push('--max-seconds', String(options.maxSeconds))
  }
  const worker = await run(workerArgs, {
    timeoutMs: Math.max(timeoutMs, 1_800_000),
    signal: options.signal,
    maxOutputBytes: 32 * 1024 * 1024
  })
  if (worker.exitCode !== 0) {
    let detail = worker.stderr.trim().slice(-600)
    try {
      const parsed = parseDspOutput(worker.stdout)
      if (parsed?.error !== undefined) detail = parsed.error
    } catch {
      // keep the stderr tail
    }
    throw new Error(`DSP worker failed: ${detail}`)
  }
  const features = parseDspOutput(worker.stdout)
  if (features.ok !== true) {
    throw new Error(`DSP worker reported a failure: ${features.error ?? 'unknown error'}`)
  }
  if (options.keepReferenceAudio === false) await rm(dspWav, { force: true }).catch(() => {})

  return {
    features,
    artifacts: {
      dspWav: options.keepReferenceAudio === false ? null : dspWav,
      referenceAudio
    },
    elapsedMs: Date.now() - started
  }
}

/**
 * Keep a lossless copy of the original audio. The generator stage needs the
 * source audio itself, and a lossy re-encode here would silently degrade what
 * every later comparison is measured against.
 */
async function writeReferenceAudio(run, options, referenceDir, timeoutMs) {
  if (options.keepReferenceAudio === false) return null
  const out = join(referenceDir, 'source-audio.flac')
  const result = await run(
    [
      'ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
      '-i', options.filePath,
      '-vn', '-c:a', 'flac', '-compression_level', '5',
      out
    ],
    { timeoutMs, signal: options.signal, maxOutputBytes: 256 * 1024 }
  )
  if (result.exitCode !== 0) {
    // Not fatal: the DSP result is still valid, but say so rather than pretend.
    return { path: null, warning: `lossless copy failed: ${result.stderr.trim().slice(-200)}` }
  }
  return { path: out, warning: null }
}
