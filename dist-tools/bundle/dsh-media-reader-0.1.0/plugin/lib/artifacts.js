/**
 * Artifact directories, transcript files, and the one-media-job-at-a-time lock.
 *
 * RAM on this machine is the binding constraint (T4 profile), so audio and
 * video processing are serialized inside the plugin process as well as by the
 * subprocess timeout.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MediaError } from './errors.js'

let mediaLock = Promise.resolve()

/** Run one media job at a time. Rejections do not poison the chain. */
export function withMediaLock(task) {
  const run = mediaLock.then(task, task)
  mediaLock = run.then(() => undefined, () => undefined)
  return run
}

/** Create one artifact directory and return its absolute path. */
export async function ensureArtifactDir(baseDir, category, name) {
  if (typeof baseDir !== 'string' || baseDir.length === 0) {
    throw new MediaError('NO_ARTIFACT_DIR', 'no artifact directory is configured')
  }
  const safeName = name.replace(/[^a-zA-Z0-9._-]+/gu, '-').slice(0, 80) || 'media'
  const dir = join(baseDir, category, `${safeName}-${Date.now()}`)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  return dir
}

/** HH:MM:SS,mmm for SRT. */
export function srtTimestamp(seconds) {
  const totalMs = Math.max(0, Math.round((Number.isFinite(seconds) ? seconds : 0) * 1000))
  const hours = Math.floor(totalMs / 3_600_000)
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000)
  const secs = Math.floor((totalMs % 60_000) / 1000)
  const millis = totalMs % 1000
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(millis).padStart(3, '0')}`
}

/** Render timestamped segments as SRT. */
export function toSrt(segments) {
  return segments
    .map((segment, index) => `${index + 1}\n${srtTimestamp(segment.start)} --> ${srtTimestamp(segment.end)}\n${segment.text}\n`)
    .join('\n')
}

/** Render a compact readable transcript with timestamps. */
export function toReadableTranscript(segments) {
  return segments
    .map((segment) => `[${srtTimestamp(segment.start)}] ${segment.text}`)
    .join('\n')
}

/** Write transcript.txt / transcript.json / transcript.srt into one artifact dir. */
export async function writeTranscriptArtifacts(dir, transcript) {
  const payload = {
    model: transcript.model,
    computeType: transcript.computeType,
    language: transcript.language,
    languageProbability: transcript.languageProbability,
    duration: transcript.duration,
    text: transcript.text,
    segments: transcript.segments
  }
  const [txtPath, jsonPath, srtPath] = [join(dir, 'transcript.txt'), join(dir, 'transcript.json'), join(dir, 'transcript.srt')]
  await Promise.all([
    writeFile(txtPath, `${toReadableTranscript(transcript.segments)}\n`, 'utf8'),
    writeFile(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8'),
    writeFile(srtPath, `${toSrt(transcript.segments)}\n`, 'utf8')
  ])
  return { transcriptTxt: txtPath, transcriptJson: jsonPath, transcriptSrt: srtPath }
}
