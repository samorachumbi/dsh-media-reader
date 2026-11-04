/**
 * Artifact directories, transcript files, and the one-media-job-at-a-time lock.
 *
 * RAM on this machine is the binding constraint (T4 profile), so audio and
 * video processing are serialized inside the plugin process as well as by the
 * subprocess timeout.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, sep } from 'node:path'
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

/**
 * Render one artifact path for model-facing text.
 *
 * The text a tool returns is also the text the drag-and-drop route inserts into
 * the composer draft, and a draft is something a human sends, pastes into a
 * ticket or photographs. An absolute path there publishes the user's directory
 * layout, so artifact references are printed relative to the artifacts root; a
 * path outside that root is reduced to its file name rather than leaked.
 *
 * `resolveMediaTarget` understands these relative references, so the advice the
 * digest gives ("call media_image on the frame path") still works.
 */
export function artifactRef(artifactsRoot, target) {
  if (typeof target !== 'string' || target.length === 0) return target
  if (typeof artifactsRoot === 'string' && artifactsRoot.length > 0) {
    const root = artifactsRoot.endsWith(sep) ? artifactsRoot : `${artifactsRoot}${sep}`
    if (target.startsWith(root)) return target.slice(root.length)
    if (target === artifactsRoot) return basename(target)
  }
  return isAbsolute(target) ? basename(target) : target
}

/** Apply `artifactRef` to one path, an array of paths, or a flat map of them. */
export function artifactRefs(artifactsRoot, value) {
  if (typeof value === 'string') return artifactRef(artifactsRoot, value)
  if (Array.isArray(value)) return value.map((entry) => artifactRefs(artifactsRoot, entry))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, artifactRefs(artifactsRoot, entry)]))
  }
  return value
}

/**
 * The one line that makes a relative artifact reference actionable, printed
 * beside the paths themselves. Without it a model resolves them against the
 * session workspace and finds nothing.
 */
export const ARTIFACT_NOTE =
  '<note>artifact paths are relative to the configured artifacts directory; pass them to the media tools exactly as written</note>'

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
