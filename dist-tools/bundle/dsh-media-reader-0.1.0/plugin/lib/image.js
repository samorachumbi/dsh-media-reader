/**
 * Image admission and route-aware presentation.
 *
 * A vision-capable route receives the real image block. A text-only route
 * receives a factual description from the configured vision route. Neither
 * path invents an observation when the capability is missing.
 */
import { basename, extname } from 'node:path'
import { describeImageAttachment } from './describe.js'
import { MediaError } from './errors.js'
import { resolveCurrentRoute, resolveVisionRoute } from './route.js'

const MEDIA_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
}

export const IMAGE_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    attachmentId: { type: 'string', required: true },
    mediaType: { type: 'string', required: true },
    bytes: { type: 'integer', required: true },
    width: { type: 'integer', required: true },
    height: { type: 'integer', required: true },
    name: { type: 'string' },
    originalDimensions: {
      type: 'object',
      additionalProperties: false,
      properties: {
        width: { type: 'integer', required: true },
        height: { type: 'integer', required: true }
      }
    }
  }
}

/** Declared media type for a supported image path, or undefined. */
export function imageMediaTypeForPath(filePath) {
  return MEDIA_TYPES[extname(filePath).toLowerCase()]
}

/**
 * Read and durably admit one image.
 * @param {object} ctx plugin context
 * @param {{displayPath: string, target: object}} resolved resolved media target
 * @param {AbortSignal|undefined} signal
 */
export async function readImageAttachment(ctx, resolved, signal) {
  const mediaType = imageMediaTypeForPath(resolved.displayPath)
  if (mediaType === undefined) {
    throw new MediaError(
      'UNSUPPORTED_IMAGE',
      `"${resolved.displayPath}" is not a PNG/JPEG/WebP/GIF image`
    )
  }
  const attachments = ctx.get('attachments')
  if (attachments === undefined) {
    throw new MediaError('NO_ATTACHMENTS', 'the attachment service is not mounted, so images cannot be admitted')
  }
  if (!attachments.imageLimits.mediaTypes.includes(mediaType)) {
    throw new MediaError('UNSUPPORTED_IMAGE_TYPE', `${mediaType} images are not accepted by this deployment`)
  }
  const byteCap = Math.min(attachments.imageLimits.maxImageBytes, attachments.imageLimits.maxMessageImageBytes)
  const data = await ctx.fs.readBytes(resolved.target, signal, byteCap)
  try {
    const ref = await attachments.saveImage({
      data,
      mediaType,
      name: basename(resolved.displayPath)
    })
    return {
      attachmentId: ref.attachmentId,
      mediaType: ref.mediaType,
      bytes: ref.bytes,
      width: ref.width,
      height: ref.height,
      ...(ref.name === undefined ? {} : { name: ref.name }),
      ...(ref.originalDimensions === undefined
        ? {}
        : { originalDimensions: { ...ref.originalDimensions } })
    }
  } catch (error) {
    if (error?.name !== 'AttachmentError') throw error
    if (error.code === 'IMAGE_TYPE_MISMATCH') {
      throw new MediaError(
        'IMAGE_TYPE_MISMATCH',
        `"${resolved.displayPath}" has an image extension but its bytes are a different format; rename or convert it`
      )
    }
    if (error.code === 'IMAGE_DIMENSION_TOO_LARGE') {
      throw new MediaError('IMAGE_TOO_LARGE', `"${resolved.displayPath}" exceeds the per-side pixel limit; downscale it first`)
    }
    if (error.code === 'IMAGE_TOO_MANY_PIXELS') {
      throw new MediaError('IMAGE_TOO_LARGE', `"${resolved.displayPath}" exceeds the decoded-pixel limit; downscale it first`)
    }
    if (error.code === 'IMAGE_TOO_LARGE') {
      throw new MediaError('IMAGE_TOO_LARGE', `"${resolved.displayPath}" exceeds the attachment byte limit; downscale it first`)
    }
    throw error
  }
}

/** The text envelope that always accompanies a returned image block. */
export function imageEnvelope(displayPath, image) {
  const scaled = image.originalDimensions === undefined
    ? ''
    : ` (downscaled from ${image.originalDimensions.width}x${image.originalDimensions.height} px)`
  return `<path>${displayPath}</path>
<type>image</type>
<content>
${image.mediaType} image, ${image.width}x${image.height} px, ${image.bytes} bytes${scaled}
</content>`
}

/**
 * Describe an already-admitted image through the configured vision route.
 * @returns {Promise<{text: string, provider: string, model: string, latencyMs: number}>}
 */
export async function describeAdmittedImage(ctx, config, image, exec, question) {
  if (config.visionFallback === 'off') {
    throw new MediaError(
      'VISION_FALLBACK_OFF',
      'this model cannot accept images and the vision fallback is disabled; switch to an image-capable model or enable visionFallback'
    )
  }
  const route = await resolveVisionRoute(ctx, config, exec.signal)
  return describeImageAttachment(ctx, image, route, {
    question,
    signal: exec.signal,
    timeoutMs: config.visionTimeoutMs,
    sessionId: exec.agent?.session?.id,
    maxTokens: config.visionMaxTokens
  })
}

/** Human-readable provenance for a described image. */
export function descriptionWithProvenance(displayPath, image, description) {
  return `<path>${displayPath}</path>
<type>image-description</type>
<source>${description.provider}/${description.model}</source>
<latencyMs>${description.latencyMs}</latencyMs>
<image>${image.mediaType} ${image.width}x${image.height} px, ${image.bytes} bytes</image>
<content>
${description.text}
</content>`
}

/**
 * Route-aware presentation of one image.
 * @returns {Promise<{canSeeImages: boolean, image?: object, text: string}>}
 */
export async function presentImage(ctx, config, resolved, exec, question) {
  const route = await resolveCurrentRoute(ctx, exec)
  const image = await readImageAttachment(ctx, resolved, exec.signal)
  if (route.canSeeImages) {
    return { canSeeImages: true, image, text: imageEnvelope(resolved.displayPath, image) }
  }
  const description = await describeAdmittedImage(ctx, config, image, exec, question)
  return {
    canSeeImages: false,
    image,
    text: descriptionWithProvenance(resolved.displayPath, image, description)
  }
}
