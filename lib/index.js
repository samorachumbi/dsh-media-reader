/**
 * dsh-media-reader — read local images, audio and video from DeepSeek Harness.
 *
 * Four tools plus one pre-execute redirect:
 * - media_probe   metadata only, no model call
 * - media_image   pixels on a vision route, description on a text-only route
 * - media_audio   local transcription to timestamped text
 * - media_video   frames/contact sheet or a fused text digest
 *
 * The redirect takes a failed-by-design `read_image` on a text-only route and
 * points the model at media_image instead of pretending the failure succeeded.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveCurrentRoute } from './route.js'
import { resolveMediaTarget } from './fsutil.js'
import { MediaError } from './errors.js'
import { isSupportedMediaPath, kindFromPath, probeTarget } from './probe.js'
import { IMAGE_VALUE_SCHEMA, presentImage } from './image.js'
import { registerAudioTool } from './audio.js'
import { registerVideoTool } from './video.js'
import { registerUploadRoute } from './upload-route.js'
import { defaultModelDir, defaultSttPython } from './stt.js'
import { buildEvidencePack, jobNameFor } from './evidence/index.js'
import { createPluginRunner } from './evidence/runner.js'
import { formatEvidenceSummary } from './evidence/summary.js'
import { resolveKieKey } from './kie/client.js'
import { runProcess } from './exec.js'

export { formatEvidenceSummary }
export const name = 'dsh-media-reader'
export const inject = ['tools', 'fs', 'subprocess', 'webServer']

const DEFAULT_CONFIG = {
  artifactsDir: join(homedir(), 'projects', 'Video_Image_Voice', 'artifacts'),
  visionProvider: undefined,
  visionModel: undefined,
  visionFallback: 'configured-route',
  autoRedirect: true,
  visionTimeoutMs: 90_000,
  visionMaxTokens: 2000,
  sttPython: undefined,
  sttWorker: undefined,
  sttModelDir: undefined,
  sttModel: 'base',
  sttComputeType: 'int8',
  sttThreads: 4,
  sttBeamSize: 1,
  maxAudioSeconds: 300,
  sttTimeoutMs: 900_000,
  ffmpegTimeoutMs: 180_000,
  sceneThreshold: 10,
  sceneTimeoutMs: 120_000,
  maxFrames: 4,
  maxFrameSide: 800,
  maxFramePixels: 640_000,
  maxUploadBytes: 128 * 1024 * 1024,
  uploadTimeoutMs: 600_000,
  replicationDir: join(homedir(), 'projects', 'Video_Image_Voice', 'replication'),
  evidenceMaxShots: 20,
  evidenceLyrics: true,
  evidenceTimeoutMs: 1_800_000,
  kieEnv: join(homedir(), 'projects', 'Website_Builder', '.env'),
  kieMinCredits: 0,
  evidenceStems: true,
  evidenceSemantic: true,
  evidenceSemanticFrames: 6,
  // Test seam: a unit test supplies its own runner instead of spawning processes.
  evidenceRunner: undefined
}

/**
 * Merge caller settings over the defaults. Exported so an instrument can run the
 * real pipeline with the product's own defaults instead of a copy of them.
 */
export function normalizeConfig(config) {
  const merged = { ...DEFAULT_CONFIG, ...(config ?? {}) }
  if (merged.visionFallback !== 'configured-route' && merged.visionFallback !== 'off') {
    throw new Error(`media-reader: visionFallback must be "configured-route" or "off", got ${JSON.stringify(merged.visionFallback)}`)
  }
  if (merged.sttPython === undefined) merged.sttPython = defaultSttPython()
  if (merged.sttModelDir === undefined) merged.sttModelDir = defaultModelDir()
  return merged
}

function modelFacingError(error) {
  if (error instanceof MediaError) return new Error(`${error.code}: ${error.message}`)
  return error
}

function registerProbeTool(ctx) {
  ctx.tools.register(defineTool({
    name: 'media_probe',
    description:
      'Inspect a local image, audio file or video and return its real metadata as JSON: kind, container, ' +
      'duration, dimensions, frame rate, codecs, audio-track count, subtitle-track count. Uses ffprobe only; ' +
      'makes no model call. Call this before a deeper media read when the file type is unknown.',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'Path to a local image, audio or video file, resolved against the session workspace.'
      }
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }]
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      try {
        if (!isSupportedMediaPath(args.path)) {
          throw new MediaError(
            'UNSUPPORTED_MEDIA',
            `"${args.path}" is not a supported image/audio/video extension`
          )
        }
        const resolved = await resolveMediaTarget(ctx, exec, args.path, { artifactsDir: config.artifactsDir })
        const info = await probeTarget(ctx, resolved.target, {
          signal: exec.signal,
          displayPath: resolved.displayPath,
          sizeBytes: resolved.info.size
        })
        if (info.kind === 'unknown') {
          throw new MediaError('UNSUPPORTED_MEDIA', `ffprobe could not classify "${resolved.displayPath}" as image, audio or video`)
        }
        return JSON.stringify(info, null, 2)
      } catch (error) {
        throw modelFacingError(error)
      }
    }
  }))
}

function registerImageTool(ctx, config) {
  ctx.tools.register(defineTool({
    name: 'media_image',
    description:
      'Read one local PNG/JPEG/WebP/GIF image. On a model that accepts images the image itself is attached. ' +
      'On a text-only model the image is described by the configured vision route, and the result says which ' +
      'route described it. Ask a question to focus the description. Use this instead of read_image on a ' +
      'text-only route.',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'Path to a local image, resolved against the session workspace.'
      },
      question: {
        type: 'string',
        description: 'Optional question the description should answer from the image.'
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          image: IMAGE_VALUE_SCHEMA
        }
      },
      render: (_args, value) => [
        { type: 'text', text: value.text },
        ...(value.image === undefined ? [] : [{ type: 'image', attachment: value.image }])
      ]
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      try {
        if (kindFromPath(args.path) !== 'image') {
          throw new MediaError('UNSUPPORTED_IMAGE', `"${args.path}" is not a supported image path`)
        }
        const resolved = await resolveMediaTarget(ctx, exec, args.path, { artifactsDir: config.artifactsDir })
        const presented = await presentImage(ctx, config, resolved, exec, args.question)
        return {
          text: presented.text,
          ...(presented.canSeeImages ? { image: presented.image } : {})
        }
      } catch (error) {
        throw modelFacingError(error)
      }
    }
  }))
}

function registerEvidenceTool(ctx, config) {
  const runner = config.evidenceRunner ?? createPluginRunner(ctx, runProcess)
  ctx.tools.register(defineTool({
    name: 'media_evidence',
    description:
      'Measure one local audio or video file into a replication evidence pack: tempo, key, cadence, ' +
      'loudness, energy, timbre, novelty regions, shot boundaries with real frames, and lyrics with a ' +
      'confidence verdict. Every value is tagged MEASURED, INFERRED or UNVERIFIED, and anything it cannot ' +
      'measure (instruments, camera, action, on-screen text) is reported as UNVERIFIED with the reason ' +
      'instead of being guessed. It makes NO generation call and no network call. This is slow — roughly ' +
      '1-4 minutes for a full-length music video — so prefer media_video for a quick look and use this ' +
      'when you need evidence a generator can be held to.',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'Path to a local audio or video file, resolved against the session workspace.'
      },
      mode: {
        type: 'string',
        enum: ['replica', 'transform'],
        description: 'replica preserves structure and melody; transform changes the treatment (e.g. anime ' +
          'characters) while preserving composition and storyline. Default replica.'
      },
      profile: {
        type: 'string',
        enum: ['local', 'assisted', 'cloud'],
        description: 'Execution profile. local makes no model call at all (default); assisted and cloud ' +
          'add a semantic pass in a later stage. Generation is remote in every profile.'
      },
      shots: {
        type: 'number',
        description: 'How many shot boundaries to sample with frames. Default 20; each shot costs a few seconds.'
      },
      lyrics: {
        type: 'boolean',
        description: 'Transcribe the audio track with local Whisper. Default true; false saves about a minute.'
      },
      maxSeconds: {
        type: 'number',
        description: 'Analyse only the first N seconds. Omit to measure the whole file, which is the default ' +
          'and the point of this tool.'
      },
      semanticFrames: {
        type: 'number',
        description: 'Keyframes attached to the assisted semantic pass (default 6). Only used when profile is ' +
          'assisted or cloud.'
      }
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }]
    },
    // One media job at a time: this spawns ffmpeg and a DSP worker heavy enough
    // to matter on a 7.6 GB machine, and the pack also holds the media lock.
    isConcurrencySafe: () => false,
    timeoutMs: config.evidenceTimeoutMs,
    async execute(args, exec) {
      try {
        if (!isSupportedMediaPath(args.path)) {
          throw new MediaError('UNSUPPORTED_MEDIA', `"${args.path}" is not a supported image/audio/video extension`)
        }
        // Reject a still image by extension, before any process is spawned: a
        // wrong tool call should cost nothing, not an ffprobe plus a 20-minute
        // measurement of something that has no timeline.
        if (kindFromPath(args.path) === 'image') {
          throw new MediaError('UNSUPPORTED_MEDIA', 'media_evidence measures audio and video timelines; use media_image for a still image')
        }
        const resolved = await resolveMediaTarget(ctx, exec, args.path, { artifactsDir: config.artifactsDir })
        const info = await probeTarget(ctx, resolved.target, {
          signal: exec.signal,
          displayPath: resolved.displayPath,
          sizeBytes: resolved.info.size
        })
        if (info.kind === 'image') {
          throw new MediaError('UNSUPPORTED_MEDIA', 'media_evidence measures audio and video timelines; use media_image for a still image')
        }
        if (info.kind === 'unknown') {
          throw new MediaError('UNSUPPORTED_MEDIA', `ffprobe could not classify "${resolved.displayPath}"`)
        }
        // A paid profile resolves the credential before any stage runs.
        let kieKey
        if ((args.profile ?? 'local') !== 'local') {
          kieKey = await resolveKieKey({ envFile: config.kieEnv })
        }
        const result = await buildEvidencePack({
          run: runner,
          filePath: resolved.processPath,
          outDir: config.replicationDir,
          job: jobNameFor(resolved.displayPath),
          mode: args.mode ?? 'replica',
          profile: args.profile ?? 'local',
          python: config.sttPython ?? defaultSttPython(),
          sttWorker: config.sttWorker,
          modelDir: config.sttModelDir,
          sttModel: config.sttModel,
          sttThreads: config.sttThreads,
          maxShots: args.shots ?? config.evidenceMaxShots,
          lyrics: args.lyrics === undefined ? config.evidenceLyrics : args.lyrics,
          maxAudioSeconds: args.maxSeconds,
          kieKey,
          minCredits: config.kieMinCredits,
          stems: config.evidenceStems,
          semantic: config.evidenceSemantic,
          semanticFrames: args.semanticFrames ?? config.evidenceSemanticFrames,
          signal: exec.signal
        })
        return formatEvidenceSummary(result)
      } catch (error) {
        throw modelFacingError(error)
      }
    }
  }))
}

function registerReadImageRedirect(ctx, config) {
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (!config.autoRedirect || exec.name !== 'read_image') return next()
    const filePath = exec.arguments?.file_path
    if (typeof filePath !== 'string' || filePath.trim().length === 0) return next()
    let route
    try {
      route = await resolveCurrentRoute(ctx, exec)
    } catch {
      return next()
    }
    if (!route.resolved || route.canSeeImages) return next()
    return {
      kind: 'deny',
      reason:
        `This model cannot consume image blocks (read_image would fail). Call media_image with ` +
        `path ${JSON.stringify(filePath)}; it returns a text description with provenance.`
    }
  })
}

export function apply(ctx, config) {
  const settings = normalizeConfig(config)
  registerProbeTool(ctx)
  registerImageTool(ctx, settings)
  registerAudioTool(ctx, settings)
  registerVideoTool(ctx, settings)
  registerUploadRoute(ctx, settings)
  registerEvidenceTool(ctx, settings)
  registerReadImageRedirect(ctx, settings)
}
