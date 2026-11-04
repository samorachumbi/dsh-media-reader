/**
 * Host-side ingestion for drag-and-drop uploads.
 *
 * The browser sends a file that is not part of the conversation's attachment
 * stream. This module writes it through the same local pipeline as the tools and
 * always returns text, so the result can be inserted into any model's draft.
 */
import { MediaError } from './errors.js'
import { resolveMediaTarget } from './fsutil.js'
import { describeAdmittedImage, descriptionWithProvenance, readImageAttachment } from './image.js'
import { probeTarget } from './probe.js'
import { transcribeMedia } from './stt.js'
import { transcriptEnvelope } from './audio.js'
import { describeVideoUpload } from './video.js'

/**
 * @param {object} ctx plugin context (fs, attachments, llm, subprocess)
 * @param {object} config normalized settings
 * @param {{path: string, name: string, question?: string, signal?: AbortSignal}} input
 * @returns {Promise<{kind: string, text: string, artifacts?: object}>}
 */
export async function ingestUpload(ctx, config, input) {
  const exec = { signal: input.signal }
  const resolved = await resolveMediaTarget(ctx, exec, input.path, { artifactsDir: config.artifactsDir })
  const probe = await probeTarget(ctx, resolved.target, {
    signal: input.signal,
    displayPath: input.name,
    sizeBytes: resolved.info.size
  })

  if (probe.kind === 'image') {
    const image = await readImageAttachment(ctx, resolved, input.signal)
    const description = await describeAdmittedImage(ctx, config, image, exec, input.question)
    return {
      kind: 'image',
      text: descriptionWithProvenance(input.name, image, description)
    }
  }

  if (probe.kind === 'audio') {
    if (probe.audioTracks === 0) {
      throw new MediaError('NO_AUDIO_TRACK', `"${input.name}" has no audio track`)
    }
    const transcript = await transcribeMedia(ctx, config, resolved, {
      durationSeconds: probe.durationSeconds,
      signal: input.signal
    })
    return {
      kind: 'audio',
      // The upload route has the same duration defect as the tool: the file's
      // real duration must not be reported as the transcribed window.
      text: transcriptEnvelope(input.name, transcript, probe.durationSeconds, { artifactsRoot: config.artifactsDir }),
      artifacts: transcript.artifacts
    }
  }

  if (probe.kind !== 'video' || probe.image === undefined) {
    throw new MediaError('UNSUPPORTED_MEDIA', `"${input.name}" is not a readable image, audio or video file`)
  }

  return {
    kind: 'video',
    ...(await describeVideoUpload(ctx, config, resolved, probe, {
      question: input.question,
      signal: input.signal,
      displayPath: input.name
    }))
  }
}
