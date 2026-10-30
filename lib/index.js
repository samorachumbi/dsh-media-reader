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
  uploadTimeoutMs: 600_000
}

function normalizeConfig(config) {
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
        const resolved = await resolveMediaTarget(ctx, exec, args.path)
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
        const resolved = await resolveMediaTarget(ctx, exec, args.path)
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
  registerReadImageRedirect(ctx, settings)
}
