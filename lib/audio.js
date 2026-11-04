/**
 * media_audio — local transcription of an audio file or a video's audio track.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ARTIFACT_NOTE, artifactRefs } from './artifacts.js'
import { MediaError } from './errors.js'
import { resolveMediaTarget } from './fsutil.js'
import { kindFromPath, probeTarget } from './probe.js'
import { transcribeMedia } from './stt.js'

const ALLOWED_MODELS = new Set(['tiny', 'base', 'small', 'medium'])

function modelFacingError(error) {
  if (error instanceof MediaError) return new Error(`${error.code}: ${error.message}`)
  return error
}

/**
 * @param {string} displayPath
 * @param {object} transcript
 * @param {number|undefined} [fileDurationSeconds] the file's real duration, when known
 * @param {{artifactsRoot?: string}} [options] the artifacts root artifact paths are printed relative to
 */
export function transcriptEnvelope(displayPath, transcript, fileDurationSeconds, options = {}) {
  const hasSpeech = transcript.segments.length > 0
  const language = transcript.languageProbability === null || transcript.languageProbability === undefined
    ? transcript.language
    : `${transcript.language} (p=${Number(transcript.languageProbability).toFixed(2)})`
  const lines = [
    `<path>${displayPath}</path>`,
    '<type>audio-transcript</type>',
    `<processor>faster-whisper ${transcript.model} ${transcript.computeType} (local)</processor>`,
    `<language>${language}</language>`,
    // `durationSeconds` is the FILE's duration; the processed window is a
    // separate field. It used to report the transcript's capped length under
    // this name, so a 368.013 s MP3 came back as "durationSeconds 300.00" —
    // a claim about the file that the file contradicts.
    `<durationSeconds>${Number(Number.isFinite(fileDurationSeconds) ? fileDurationSeconds : transcript.duration).toFixed(2)}</durationSeconds>`,
    `<processedSeconds>${Number(transcript.duration).toFixed(2)}</processedSeconds>`,
    `<realTimeFactor>${transcript.realTimeFactor}</realTimeFactor>`,
    `<artifacts>${JSON.stringify(artifactRefs(options.artifactsRoot, transcript.artifacts))}</artifacts>`,
    ARTIFACT_NOTE
  ]
  if (transcript.truncated) {
    lines.push(
      `<truncated>only the first ${transcript.duration.toFixed(1)} of ${Number(Number.isFinite(fileDurationSeconds) ? fileDurationSeconds : transcript.duration).toFixed(1)} seconds were transcribed; ` +
      'raise maxSeconds (up to the configured cap) or use media_evidence, which never truncates</truncated>'
    )
  }
  if (!hasSpeech) {
    lines.push(
      `<content>no speech detected in ${Number(transcript.duration).toFixed(1)} s. ` +
      'Speech recognition found no words; non-speech audio (music, tones, sound events) is out of scope for this tool.</content>'
    )
    return lines.join('\n')
  }
  lines.push('<content>')
  for (const segment of transcript.segments.slice(0, 60)) {
    lines.push(`[${segment.start.toFixed(2)}-${segment.end.toFixed(2)}] ${segment.text}`)
  }
  if (transcript.segments.length > 60) {
    lines.push(`... ${transcript.segments.length - 60} more segments in transcript.txt`)
  }
  lines.push('</content>')
  return lines.join('\n')
}

export function registerAudioTool(ctx, config) {
  ctx.tools.register(defineTool({
    name: 'media_audio',
    description:
      'Transcribe a local audio file, or the audio track of a local video, to timestamped text using a ' +
      'local Whisper model. Audio stays on this machine. Returns a transcript preview plus paths to the ' +
      'full transcript.txt, transcript.json and transcript.srt. If the file has no speech, it says so ' +
      'explicitly; it never invents words.',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'Local audio or video path, resolved against the session workspace.'
      },
      language: {
        type: 'string',
        description: 'Language hint such as en or sw; omit for automatic detection.'
      },
      model: {
        type: 'string',
        description: `Local Whisper model: ${[...ALLOWED_MODELS].join(', ')}. Omit for the configured default.`
      },
      maxSeconds: {
        type: 'number',
        description: `Process at most this many seconds (hard cap ${config.maxAudioSeconds}).`
      }
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }]
    },
    timeoutMs: config.sttTimeoutMs + config.ffmpegTimeoutMs + 60_000,
    async execute(args, exec) {
      try {
        const requestedModel = args.model ?? config.sttModel
        if (!ALLOWED_MODELS.has(requestedModel)) {
          throw new MediaError('STT_MODEL_UNSUPPORTED', `unsupported Whisper model "${requestedModel}"; use ${[...ALLOWED_MODELS].join(', ')}`)
        }
        const kind = kindFromPath(args.path)
        if (kind !== 'audio' && kind !== 'video') {
          throw new MediaError('UNSUPPORTED_AUDIO', `"${args.path}" is not a supported audio or video path`)
        }
        const resolved = await resolveMediaTarget(ctx, exec, args.path, { artifactsDir: config.artifactsDir })
        const probe = await probeTarget(ctx, resolved.target, {
          signal: exec.signal,
          displayPath: resolved.displayPath,
          sizeBytes: resolved.info.size
        })
        if (probe.audioTracks === 0) {
          throw new MediaError('NO_AUDIO_TRACK', `"${resolved.displayPath}" has no audio track`)
        }
        const maxSeconds = Math.min(args.maxSeconds ?? config.maxAudioSeconds, config.maxAudioSeconds)
        const transcript = await transcribeMedia(ctx, config, resolved, {
          durationSeconds: probe.durationSeconds,
          language: args.language,
          model: requestedModel,
          maxSeconds,
          signal: exec.signal
        })
        return transcriptEnvelope(resolved.displayPath, transcript, probe.durationSeconds, { artifactsRoot: config.artifactsDir })
      } catch (error) {
        throw modelFacingError(error)
      }
    }
  }))
}
