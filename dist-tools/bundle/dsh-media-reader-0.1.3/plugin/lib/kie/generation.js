/**
 * Kie generation adapter: plan first, prove the spend gate, then execute.
 *
 * Three deliberately narrow workflows:
 *   - upload-and-cover: a 10-360 s cue can be re-styled while retaining melody
 *   - reference-to-video: short reference clips/images guide a new clip
 *   - animate-replace: a source clip is re-performed using a reference image
 *
 * Safety properties that are part of the contract, not CLI decoration:
 *   1. No execution unless `enabled === true` AND a positive `maxCredits` cap is set.
 *   2. The balance is read and checked before any file is uploaded or task created.
 *   3. Every submitted task gets a ledger row, including failures.
 *   4. Provider result URLs are downloaded immediately; a URL is never the only copy.
 *   5. The request plan is written before the first network call and contains no credential.
 *   6. There is no price-quote endpoint, so the per-task cap is enforced before the call using
 *      the available balance and after the call using the provider's reported consumption.
 *      A provider charge cannot be cancelled retroactively; an over-cap job is archived,
 *      recorded, and then fails loudly.
 *   7. The pilot envelope is cumulative: prior generation-result.json files under the output
 *      root are summed, and an unknown prior charge fails closed before upload.
 */
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'
import {
  appendLedger,
  createTask,
  downloadToFile,
  getCredits,
  getJobRecord,
  KieError,
  mimeTypeForPath,
  uploadFile,
  waitForTask
} from './client.js'

export const GENERATION_WORKFLOWS = Object.freeze({
  'upload-and-cover': Object.freeze({
    model: 'ai-music-api/upload-and-cover-audio',
    kind: 'audio',
    defaultExtension: '.mp3',
    assetRoles: Object.freeze({ audio: 1 })
  }),
  'music-generate': Object.freeze({
    model: 'ai-music-api/generate',
    kind: 'audio',
    defaultExtension: '.mp3',
    assetRoles: Object.freeze({})
  }),
  'reference-to-video': Object.freeze({
    model: 'kling-4.0/reference-to-video',
    kind: 'video',
    defaultExtension: '.mp4',
    assetRoles: Object.freeze({ video: 5, image: 10 })
  }),
  'animate-replace': Object.freeze({
    model: 'wan/2-2-animate-replace',
    kind: 'video',
    defaultExtension: '.mp4',
    assetRoles: Object.freeze({ video: 1, image: 1 })
  })
})

const WORKFLOW_ALIASES = Object.freeze({
  cover: 'upload-and-cover',
  'upload-cover': 'upload-and-cover',
  music: 'music-generate',
  'text-to-music': 'music-generate',
  'generate-music': 'music-generate',
  'reference-video': 'reference-to-video',
  reference: 'reference-to-video',
  animate: 'animate-replace',
  'wan-animate-replace': 'animate-replace'
})

export const COVER_MODELS = Object.freeze(['V6', 'V6_MINI', 'V6_WILD'])
export const VIDEO_RESOLUTIONS = Object.freeze(['480p', '580p', '720p'])
export const REFERENCE_RESOLUTIONS = Object.freeze(['720p', '1080p'])
export const REFERENCE_ASPECT_RATIOS = Object.freeze(['auto', '16:9', '9:16', '1:1', '21:9'])
export const MAX_COVER_SOURCE_SECONDS = 480
export const MAX_WAN_UPLOAD_BYTES = 10 * 1024 * 1024

const ROLE_EXTENSIONS = Object.freeze({
  audio: new Set(['.mp3', '.wav', '.m4a', '.flac']),
  image: new Set(['.png', '.jpg', '.jpeg', '.webp']),
  video: new Set(['.mp4', '.mov', '.mkv'])
})

const COVER_PARAM_KEYS = [
  'uploadUrl', 'instrumental', 'sunoModel', 'duration', 'lyrics', 'prompt', 'style', 'title',
  'negativeTags', 'vocalGender', 'styleWeight', 'weirdnessConstraint', 'audioWeight', 'variety'
]
const REFERENCE_PARAM_KEYS = [
  'prompt', 'imageUrls', 'videoUrls', 'duration', 'resolution', 'aspectRatio', 'keepOriginalSound'
]
const ANIMATE_PARAM_KEYS = ['videoUrl', 'imageUrl', 'resolution']
const MUSIC_PARAM_KEYS = [
  'instrumental', 'sunoModel', 'duration', 'lyrics', 'style', 'title', 'negativeTags',
  'vocalGender', 'styleWeight', 'weirdnessConstraint', 'audioWeight', 'variety'
]

function invalid(message, detail) {
  throw new KieError('GENERATION_INVALID_PLAN', message, detail)
}

function plainObject(value, field) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid(`${field} must be an object`)
  }
  return value
}

function knownKeys(value, allowed, field) {
  const unknown = Object.keys(value).filter((key) => value[key] !== undefined && !allowed.includes(key))
  if (unknown.length > 0) invalid(`${field} has unsupported field(s): ${unknown.join(', ')}`)
}

function readText(value, field, { required = false, max = null } = {}) {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim().length === 0)) {
    if (required) invalid(`${field} is required`)
    return null
  }
  if (typeof value !== 'string') invalid(`${field} must be a string`)
  const text = value.trim()
  if (max !== null && text.length > max) invalid(`${field} exceeds ${max} characters`)
  return text
}

function readNumber(value, field, { required = false, min = -Infinity, max = Infinity, integer = false, fallback = null } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) invalid(`${field} is required`)
    return fallback
  }
  if (typeof value === 'boolean' || typeof value !== 'number' && typeof value !== 'string') {
    invalid(`${field} must be a number`)
  }
  const number = Number(value)
  if (!Number.isFinite(number)) invalid(`${field} must be a finite number`)
  if (integer && !Number.isInteger(number)) invalid(`${field} must be an integer`)
  if (number < min || number > max) invalid(`${field} must be between ${min} and ${max}`)
  return number
}

function readBoolean(value, field, fallback) {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') invalid(`${field} must be true or false`)
  return value
}

function readUnit(value, field, fallback = null) {
  const number = readNumber(value, field, { fallback })
  if (number === null) return null
  if (number < 0 || number > 1) invalid(`${field} must be between 0 and 1`)
  if (Math.abs(number * 100 - Math.round(number * 100)) > 1e-9) {
    invalid(`${field} must have at most two decimal places`)
  }
  return number
}

function readHttpUrl(value, field) {
  const text = readText(value, field, { required: true })
  let url
  try {
    url = new URL(text)
  } catch {
    invalid(`${field} must be a valid URL`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') invalid(`${field} must use http or https`)
  return text
}

function readUrlArray(value, field, maxItems) {
  if (value === undefined) return []
  if (!Array.isArray(value)) invalid(`${field} must be an array`)
  if (value.length > maxItems) invalid(`${field} accepts at most ${maxItems} item(s)`)
  return value.map((entry, index) => readHttpUrl(entry, `${field}[${index}]`))
}

function normaliseWorkflowName(workflow) {
  const raw = readText(workflow, 'workflow', { required: true }).toLowerCase()
  const canonical = WORKFLOW_ALIASES[raw] ?? raw
  if (!Object.hasOwn(GENERATION_WORKFLOWS, canonical)) {
    invalid(`unknown workflow "${raw}"; use ${Object.keys(GENERATION_WORKFLOWS).join(', ')}`)
  }
  return canonical
}

export { normaliseWorkflowName }

function normaliseCoverParams(source) {
  const params = plainObject(source ?? {}, 'params')
  const instrumental = readBoolean(params.instrumental, 'instrumental', false)
  const model = readText(params.sunoModel, 'sunoModel') ?? 'V6'
  if (!COVER_MODELS.includes(model)) invalid(`sunoModel must be one of ${COVER_MODELS.join(', ')}`)

  const clean = {
    instrumental,
    sunoModel: model,
    duration: readNumber(params.duration, 'duration', { required: true, min: 10, max: 360, integer: true }),
    lyrics: readText(params.lyrics, 'lyrics', { max: 5000 }),
    prompt: readText(params.prompt, 'prompt', { max: 5000 }),
    style: readText(params.style, 'style', { max: 1000 }),
    title: readText(params.title, 'title', { max: 80 }),
    negativeTags: readText(params.negativeTags, 'negativeTags', { max: 1000 }),
    vocalGender: readText(params.vocalGender, 'vocalGender'),
    styleWeight: readUnit(params.styleWeight, 'styleWeight'),
    weirdnessConstraint: readUnit(params.weirdnessConstraint, 'weirdnessConstraint'),
    audioWeight: readUnit(params.audioWeight, 'audioWeight'),
    variety: readNumber(params.variety, 'variety', { min: 0, max: 4, integer: true })
  }
  if (clean.vocalGender !== null && !['m', 'f'].includes(clean.vocalGender)) {
    invalid('vocalGender must be "m" or "f"')
  }
  if (instrumental) {
    for (const field of ['lyrics', 'prompt', 'vocalGender']) {
      if (clean[field] !== null) invalid(`${field} must not be set when instrumental is true`)
    }
  }
  return clean
}

function normaliseReferenceParams(source) {
  const params = plainObject(source ?? {}, 'params')
  const clean = {
    prompt: readText(params.prompt, 'prompt', { required: true, max: 8000 }),
    duration: readNumber(params.duration, 'duration', { min: 3, max: 30, integer: true, fallback: 5 }),
    resolution: readText(params.resolution, 'resolution') ?? '720p',
    aspectRatio: readText(params.aspectRatio, 'aspectRatio'),
    keepOriginalSound: readBoolean(params.keepOriginalSound, 'keepOriginalSound', false)
  }
  if (!REFERENCE_RESOLUTIONS.includes(clean.resolution)) {
    invalid(`resolution must be one of ${REFERENCE_RESOLUTIONS.join(', ')}`)
  }
  if (clean.aspectRatio !== null && !REFERENCE_ASPECT_RATIOS.includes(clean.aspectRatio)) {
    invalid(`aspectRatio must be one of ${REFERENCE_ASPECT_RATIOS.join(', ')}`)
  }
  return clean
}

function normaliseAnimateParams(source) {
  const params = plainObject(source ?? {}, 'params')
  const clean = { resolution: readText(params.resolution, 'resolution') ?? '720p' }
  if (!VIDEO_RESOLUTIONS.includes(clean.resolution)) {
    invalid(`resolution must be one of ${VIDEO_RESOLUTIONS.join(', ')}`)
  }
  return clean
}

/** Reject @mentions that do not point at a material actually included in the request. */
export function validateMentions(prompt, { imageCount = 0, videoCount = 0 } = {}) {
  const mentions = [...String(prompt).matchAll(/(?<![\w@])@([A-Za-z][A-Za-z0-9_]*)/gu)]
  for (const match of mentions) {
    const name = match[1]
    const numbered = name.match(/^(image|video)_(\d+)$/u)
    if (numbered === null) {
      invalid(`prompt mentions @${name}, but this adapter does not send elements or voices; remove the mention`)
    }
    const count = Number(numbered[2])
    const limit = numbered[1] === 'image' ? imageCount : videoCount
    if (String(count) !== numbered[2] || count < 1 || count > limit) {
      invalid(
        `prompt mentions @${name}, but the request includes ${limit} ${numbered[1]} material(s); ` +
        'every reference must be included and numbered from 1'
      )
    }
  }
  return mentions.length
}

function normaliseMusicParams(source) {
  const params = plainObject(source ?? {}, 'params')
  const instrumental = readBoolean(params.instrumental, 'instrumental', false)
  const model = readText(params.sunoModel, 'sunoModel') ?? 'V6'
  if (!COVER_MODELS.includes(model)) invalid(`sunoModel must be one of ${COVER_MODELS.join(', ')}`)
  const clean = {
    instrumental,
    sunoModel: model,
    duration: readNumber(params.duration, 'duration', { required: true, min: 10, max: 360, integer: true }),
    title: readText(params.title, 'title', { required: true, max: 80 }),
    lyrics: readText(params.lyrics, 'lyrics', { max: 5000 }),
    style: readText(params.style, 'style', { max: 1000 }),
    negativeTags: readText(params.negativeTags, 'negativeTags', { max: 1000 }),
    vocalGender: readText(params.vocalGender, 'vocalGender'),
    styleWeight: readUnit(params.styleWeight, 'styleWeight'),
    weirdnessConstraint: readUnit(params.weirdnessConstraint, 'weirdnessConstraint'),
    audioWeight: readUnit(params.audioWeight, 'audioWeight'),
    variety: readNumber(params.variety, 'variety', { min: 0, max: 4, integer: true })
  }
  if (clean.vocalGender !== null && !['m', 'f'].includes(clean.vocalGender)) {
    invalid('vocalGender must be "m" or "f"')
  }
  if (clean.style === null && clean.lyrics === null && clean.negativeTags === null) {
    invalid('music generation needs at least one of style, lyrics or negativeTags')
  }
  if (instrumental) {
    for (const field of ['lyrics', 'vocalGender', 'audioWeight']) {
      if (clean[field] !== null) invalid(`${field} must not be set when instrumental is true`)
    }
    if (clean.style === null && clean.negativeTags === null) {
      invalid('instrumental music generation needs a style or negativeTags description')
    }
  }
  return clean
}

/**
 * Build the GENERATE MUSIC input. This adapter pins custom_mode=true so duration
 * and vocal controls are predictable; it sends no image, video or audio references.
 */
export function buildMusicGenerateInput(source) {
  const params = plainObject(source ?? {}, 'music-generate input')
  knownKeys(params, MUSIC_PARAM_KEYS, 'music-generate input')
  const clean = normaliseMusicParams(params)
  const input = {
    custom_mode: true,
    instrumental: clean.instrumental,
    model: clean.sunoModel,
    title: clean.title,
    duration: clean.duration
  }
  if (clean.style !== null) input.style = clean.style
  if (clean.lyrics !== null) input.lyrics = clean.lyrics
  if (clean.negativeTags !== null) input.negative_tags = clean.negativeTags
  if (clean.vocalGender !== null) input.vocal_gender = clean.vocalGender
  if (clean.styleWeight !== null) input.style_weight = clean.styleWeight
  if (clean.weirdnessConstraint !== null) input.weirdness_constraint = clean.weirdnessConstraint
  if (clean.audioWeight !== null) input.audio_weight = clean.audioWeight
  if (clean.variety !== null) input.variety = clean.variety
  return input
}

/** Build the UPLOAD AND COVER input. No image references are allowed by this endpoint. */
export function buildCoverInput(source) {  const params = plainObject(source ?? {}, 'cover input')
  knownKeys(params, COVER_PARAM_KEYS, 'cover input')
  const clean = normaliseCoverParams(params)
  const input = {
    upload_url: readHttpUrl(params.uploadUrl, 'uploadUrl'),
    instrumental: clean.instrumental,
    model: clean.sunoModel,
    duration: clean.duration
  }
  if (clean.lyrics !== null) input.lyrics = clean.lyrics
  if (clean.prompt !== null) input.prompt = clean.prompt
  if (clean.style !== null) input.style = clean.style
  if (clean.title !== null) input.title = clean.title
  if (clean.negativeTags !== null) input.negative_tags = clean.negativeTags
  if (clean.vocalGender !== null) input.vocal_gender = clean.vocalGender
  if (clean.styleWeight !== null) input.style_weight = clean.styleWeight
  if (clean.weirdnessConstraint !== null) input.weirdness_constraint = clean.weirdnessConstraint
  if (clean.audioWeight !== null) input.audio_weight = clean.audioWeight
  if (clean.variety !== null) input.variety = clean.variety
  return input
}

/** Build the Kling 4.0 REFERENCE TO VIDEO input. */
export function buildReferenceVideoInput(source) {
  const params = plainObject(source ?? {}, 'reference-to-video input')
  knownKeys(params, REFERENCE_PARAM_KEYS, 'reference-to-video input')
  const clean = normaliseReferenceParams(params)
  const videoUrls = readUrlArray(params.videoUrls, 'videoUrls', 5)
  const imageUrls = readUrlArray(params.imageUrls, 'imageUrls', 10)
  validateMentions(clean.prompt, { imageCount: imageUrls.length, videoCount: videoUrls.length })
  const input = {
    prompt: clean.prompt,
    duration: clean.duration,
    resolution: clean.resolution
  }
  if (clean.aspectRatio !== null) input.aspect_ratio = clean.aspectRatio
  if (videoUrls.length > 0) {
    input.video_urls = videoUrls
    input.keep_original_sound = clean.keepOriginalSound
  }
  if (imageUrls.length > 0) input.image_urls = imageUrls
  return input
}

/** Build the Wan 2.2 ANIMATE REPLACE input. */
export function buildAnimateReplaceInput(source) {
  const params = plainObject(source ?? {}, 'animate-replace input')
  knownKeys(params, ANIMATE_PARAM_KEYS, 'animate-replace input')
  const clean = normaliseAnimateParams(params)
  return {
    video_url: readHttpUrl(params.videoUrl, 'videoUrl'),
    image_url: readHttpUrl(params.imageUrl, 'imageUrl'),
    resolution: clean.resolution
  }
}

function buildWorkflowRequest(workflow, params, uploads) {
  if (workflow === 'upload-and-cover') {
    return {
      model: GENERATION_WORKFLOWS[workflow].model,
      input: buildCoverInput({ ...params, uploadUrl: uploads.audio })
    }
  }
  if (workflow === 'music-generate') {
    return {
      model: GENERATION_WORKFLOWS[workflow].model,
      input: buildMusicGenerateInput(params)
    }
  }
  if (workflow === 'reference-to-video') {
    return {
      model: GENERATION_WORKFLOWS[workflow].model,
      input: buildReferenceVideoInput({ ...params, videoUrls: uploads.videos, imageUrls: uploads.images })
    }
  }
  return {
    model: GENERATION_WORKFLOWS[workflow].model,
    input: buildAnimateReplaceInput({ ...params, videoUrl: uploads.video, imageUrl: uploads.image })
  }
}

function previewUploads(workflow, assets) {
  const safe = (asset, index) => `https://upload.invalid/${asset.role}/${index}-${encodeURIComponent(basename(asset.path))}`
  if (workflow === 'upload-and-cover') return { audio: safe(assets[0], 0) }
  if (workflow === 'music-generate') return {}
  if (workflow === 'reference-to-video') {
    return {
      videos: assets.filter((asset) => asset.role === 'video').map(safe),
      images: assets.filter((asset) => asset.role === 'image').map(safe)
    }
  }
  const video = assets.find((asset) => asset.role === 'video')
  const image = assets.find((asset) => asset.role === 'image')
  return { video: safe(video, 0), image: safe(image, 0) }
}

/**
 * Validate a local asset list and return resolved facts.
 * The adapter never uploads something whose role, extension, existence or endpoint
 * size limit fails locally first.
 */
export async function validateAssets(workflow, assets) {
  if (!Array.isArray(assets)) invalid('assets must be an array')
  const normalised = []
  for (let index = 0; index < assets.length; index += 1) {
    const entry = plainObject(assets[index], `assets[${index}]`)
    const role = readText(entry.role, `assets[${index}].role`, { required: true }).toLowerCase()
    if (!Object.hasOwn(GENERATION_WORKFLOWS[workflow].assetRoles, role)) {
      invalid(`${role} is not a supported asset role for ${workflow}`)
    }
    const path = resolve(readText(entry.path, `assets[${index}].path`, { required: true }))
    let info
    try {
      info = await stat(path)
    } catch {
      invalid(`asset does not exist: ${path}`)
    }
    if (!info.isFile()) invalid(`asset is not a regular file: ${path}`)
    const extension = extname(path).toLowerCase()
    if (!ROLE_EXTENSIONS[role].has(extension)) {
      invalid(`${basename(path)} has extension ${extension}; ${role} accepts ${[...ROLE_EXTENSIONS[role]].join(', ')}`)
    }
    const mime = mimeTypeForPath(path)
    if (mime === null) invalid(`no upload MIME type is known for ${basename(path)}`)
    if (workflow === 'animate-replace' && info.size > MAX_WAN_UPLOAD_BYTES) {
      invalid(
        `${basename(path)} is ${(info.size / (1024 * 1024)).toFixed(2)} MB; ` +
        `Wan animate-replace accepts at most ${MAX_WAN_UPLOAD_BYTES / (1024 * 1024)} MB per video or image`
      )
    }
    normalised.push({ role, path, bytes: info.size, mime })
  }

  const counts = normalised.reduce((result, asset) => {
    result[asset.role] = (result[asset.role] ?? 0) + 1
    return result
  }, {})
  const limits = GENERATION_WORKFLOWS[workflow].assetRoles
  for (const role of Object.keys(counts)) {
    if (counts[role] > limits[role]) invalid(`${workflow} accepts at most ${limits[role]} ${role} asset(s)`)
  }
  if (workflow === 'upload-and-cover' && counts.audio !== 1) {
    invalid('upload-and-cover needs exactly one audio asset')
  }
  if (workflow === 'animate-replace' && (counts.video !== 1 || counts.image !== 1)) {
    invalid('animate-replace needs exactly one video and exactly one image')
  }
  return normalised
}

function normaliseParams(workflow, params) {
  if (workflow === 'upload-and-cover') {
    knownKeys(plainObject(params ?? {}, 'params'), COVER_PARAM_KEYS, 'cover params')
    return normaliseCoverParams(params)
  }
  if (workflow === 'music-generate') {
    knownKeys(plainObject(params ?? {}, 'params'), MUSIC_PARAM_KEYS, 'music params')
    return normaliseMusicParams(params)
  }
  if (workflow === 'reference-to-video') {
    knownKeys(plainObject(params ?? {}, 'params'), REFERENCE_PARAM_KEYS, 'reference params')
    return normaliseReferenceParams(params)
  }
  knownKeys(plainObject(params ?? {}, 'params'), ANIMATE_PARAM_KEYS, 'animate params')
  return normaliseAnimateParams(params)
}

function readCreditCap(value) {
  const cap = readNumber(value, 'maxCredits', { required: true, min: 0 })
  if (cap <= 0) invalid('maxCredits must be greater than zero')
  return cap
}

/**
 * Build a no-network generation plan. This is safe to run without a credential.
 * `enabled` is recorded but does not authorize execution here; executeGeneration
 * enforces it together with the cap.
 */
export async function planGeneration(options = {}) {
  const workflow = normaliseWorkflowName(options.workflow)
  const mode = readText(options.mode, 'mode') ?? 'replica'
  if (!['replica', 'transform'].includes(mode)) invalid('mode must be replica or transform')
  const change = readText(options.change, 'change', { max: 2000 })
  if (mode === 'transform' && change === null) invalid('transform mode needs a concrete change description')
  if (mode === 'replica' && change !== null) {
    invalid('replica mode does not take a change description; use transform mode for a deliberate change')
  }
  const maxCredits = readCreditCap(options.maxCredits)
  const totalMaxCredits = options.totalMaxCredits === undefined
    ? maxCredits
    : readCreditCap(options.totalMaxCredits)
  if (totalMaxCredits < maxCredits) {
    invalid('totalMaxCredits must be at least maxCredits so one task can fit within the pilot budget')
  }
  const assets = await validateAssets(workflow, options.assets ?? [])
  const params = normaliseParams(workflow, options.params)
  const warnings = []

  const sourceDurationSeconds = readNumber(
    options.sourceDurationSeconds,
    'sourceDurationSeconds',
    { min: 0 }
  )
  if (workflow === 'upload-and-cover') {
    if (sourceDurationSeconds === null) {
      warnings.push('sourceDurationSeconds was not supplied; the 8-minute source limit is enforced only by the provider')
    } else if (sourceDurationSeconds > MAX_COVER_SOURCE_SECONDS) {
      invalid(`cover source is ${sourceDurationSeconds}s; the endpoint accepts at most ${MAX_COVER_SOURCE_SECONDS}s`)
    }
  }
  if (workflow === 'reference-to-video') {
    if (assets.some((asset) => asset.role === 'video')) {
      warnings.push('reference clip durations were not probed locally; the provider enforces 2-30s per clip')
    }
    if (assets.length === 0) warnings.push('no reference material supplied; this becomes a text-to-video request')
  }
  warnings.push(
    'the provider exposes no price quote before submission; the balance floor is checked before the call and ' +
    'actual consumption is compared with the cap afterward'
  )

  const uploads = previewUploads(workflow, assets)
  const request = buildWorkflowRequest(workflow, params, uploads)
  return {
    schema: 'dsh-media-reader/generation-plan@1',
    generatedAt: new Date().toISOString(),
    workflow,
    model: GENERATION_WORKFLOWS[workflow].model,
    kind: GENERATION_WORKFLOWS[workflow].kind,
    mode,
    change,
    enabled: options.enabled === true,
    budget: {
      maxCredits,
      totalMaxCredits,
      scope: 'this task',
      totalScope: 'all generation-result.json files under the output root'
    },
    sourceDurationSeconds,
    assets,
    parameters: params,
    request,
    requestNote: 'upload.invalid URLs are local placeholders; execution replaces them with provider upload URLs',
    warnings,
    generationCall: false
  }
}

/** Fail closed unless both explicit enablement and a positive credit cap are present. */
export function assertGenerationEnabled({ enabled, maxCredits } = {}) {
  if (enabled !== true) {
    throw new KieError(
      'GENERATION_DISABLED',
      'generation is disabled by default; set enabled:true (CLI: --enable-generation) only after pilot approval'
    )
  }
  return readCreditCap(maxCredits)
}

/** Fail before upload when the account cannot cover the task cap. */
export function assertBudgetAvailable({ creditsBefore, maxCredits } = {}) {
  const cap = readCreditCap(maxCredits)
  const balance = Number(creditsBefore)
  if (!Number.isFinite(balance)) {
    throw new KieError('KIE_CREDITS_UNREADABLE', 'cannot prove the balance covers the credit cap; no task was created')
  }
  if (balance < cap) {
    throw new KieError(
      'KIE_INSUFFICIENT_CREDITS',
      `balance ${balance} is below the task cap ${cap}; no upload or task was created`
    )
  }
  return { creditsBefore: balance, maxCredits: cap }
}

/**
 * Sum credits recorded by prior generation-result.json files under one output
 * root. This is what makes the operator's pilot budget cumulative across runs
 * without a server-side ledger. An unreadable or unknown prior charge fails
 * closed rather than resetting the total.
 */
export async function readPriorGenerationSpend(outRoot) {
  const root = resolve(outRoot)
  const entries = await readdir(root, { withFileTypes: true }).catch((error) => {
    if (error?.code === 'ENOENT') return []
    throw new KieError('GENERATION_BUDGET_UNREADABLE', `cannot read ${root}: ${error.message}`)
  })
  let spent = 0
  let tasks = 0
  const unknown = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const resultPath = join(root, entry.name, 'generation-result.json')
    let result
    try {
      result = JSON.parse(await readFile(resultPath, 'utf8'))
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      unknown.push({ job: entry.name, reason: `unreadable result: ${error.message}` })
      continue
    }
    const value = result?.credits?.spent
    if (value === null || value === undefined || !Number.isFinite(Number(value))) {
      unknown.push({ job: entry.name, reason: 'no numeric credit consumption was recorded' })
      continue
    }
    spent += Number(value)
    tasks += 1
  }
  return { root, spent, tasks, unknown }
}

/** Fail before upload when the remaining pilot budget cannot absorb the task cap. */
export function assertTotalBudgetAvailable({ priorSpent, totalMaxCredits, maxCredits } = {}) {
  const total = readCreditCap(totalMaxCredits)
  const task = readCreditCap(maxCredits)
  const spent = Number(priorSpent)
  if (!Number.isFinite(spent)) {
    throw new KieError('GENERATION_BUDGET_UNVERIFIED', 'prior pilot spending is not numerically known; no task was created')
  }
  if (total < task) invalid('totalMaxCredits must be at least maxCredits so one task can fit within the pilot budget')
  const remaining = total - spent
  if (remaining < task) {
    throw new KieError(
      'GENERATION_BUDGET_EXHAUSTED',
      `pilot budget ${total} - prior spend ${spent} = ${remaining} credits remaining, below the ${task} task cap; ` +
      'no upload or task was created'
    )
  }
  return { spent, remaining, totalMaxCredits: total, maxCredits: task }
}

/** Compare cumulative consumption with the pilot envelope. */
export function evaluateTotalBudget({ priorSpent, spent, totalMaxCredits } = {}) {
  const total = readCreditCap(totalMaxCredits)
  const prior = Number(priorSpent)
  if (spent === null || spent === undefined || !Number.isFinite(Number(spent)) || !Number.isFinite(prior)) {
    return {
      ok: null,
      totalMaxCredits: total,
      priorSpent: Number.isFinite(prior) ? prior : null,
      spent: null,
      totalSpent: null,
      note: 'the cumulative pilot spend is unknown; the total cap is unverified'
    }
  }
  const totalSpent = prior + Number(spent)
  return {
    ok: totalSpent <= total + 1e-9,
    totalMaxCredits: total,
    priorSpent: prior,
    spent: Number(spent),
    totalSpent,
    exceededBy: totalSpent > total ? totalSpent - total : 0,
    note: totalSpent > total
      ? 'cumulative pilot consumption exceeded the total budget; the output is archived but the run fails'
      : 'cumulative pilot consumption is within the total budget'
  }
}

/** Compare the provider's consumption with the explicit cap. */
export function evaluateBudget({ spent, maxCredits } = {}) {
  const cap = readCreditCap(maxCredits)
  if (spent === null || spent === undefined || !Number.isFinite(Number(spent))) {
    return {
      ok: null,
      maxCredits: cap,
      spent: null,
      note: 'the provider returned no consumption figure and balance delta was unavailable; the cap is unverified'
    }
  }
  const actual = Number(spent)
  return {
    ok: actual <= cap + 1e-9,
    maxCredits: cap,
    spent: actual,
    exceededBy: actual > cap ? actual - cap : 0,
    note: actual > cap
      ? 'actual provider consumption exceeded the cap; the output is archived but the run fails'
      : 'actual provider consumption is within the cap'
  }
}

/** Pull cover tracks out of the several response shapes Kie documents/returns. */
export function extractCoverTracks(record) {
  const raw = record?.raw ?? {}
  const candidates = [
    raw.response?.data,
    raw.data?.response?.data,
    raw.response?.result?.data,
    record?.response?.data,
    record?.result?.data,
    record?.result?.response?.data,
    record?.result
  ]
  const tracks = []
  const seen = new Set()
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue
    for (const entry of candidate) {
      if (entry === null || typeof entry !== 'object') continue
      const url = [entry.audio_url, entry.source_audio_url]
        .find((value) => typeof value === 'string' && /^https?:\/\//u.test(value))
      if (url === undefined || seen.has(url)) continue
      seen.add(url)
      tracks.push({
        url,
        title: typeof entry.title === 'string' ? entry.title : null,
        durationSec: Number.isFinite(Number(entry.duration)) ? Number(entry.duration) : null,
        providerId: typeof entry.id === 'string' ? entry.id : null
      })
    }
  }
  return tracks
}

function extractResultUrls(record) {
  const sources = [record?.urls, record?.result?.resultUrls, record?.result?.result_urls]
  for (const source of sources) {
    if (!Array.isArray(source)) continue
    const urls = source.filter((url) => typeof url === 'string' && /^https?:\/\//u.test(url))
    if (urls.length > 0) return urls
  }
  return []
}

/** Normalise generation output metadata for both audio workflows and video. */
export function collectGeneratedOutputs(workflow, record) {
  if (workflow === 'upload-and-cover' || workflow === 'music-generate') {
    return extractCoverTracks(record).map((track) => ({ ...track, mediaKind: 'audio' }))
  }
  return extractResultUrls(record).map((url) => ({
    url,
    title: null,
    durationSec: null,
    providerId: null,
    mediaKind: 'video'
  }))
}

function safeSlug(value, fallback) {
  const slug = String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 48)
  return slug || fallback
}

export function generatedFileName(workflow, index, title) {
  const extension = GENERATION_WORKFLOWS[workflow].defaultExtension
  const descriptor = GENERATION_WORKFLOWS[workflow].kind === 'audio'
    ? safeSlug(title, workflow === 'upload-and-cover' ? 'cover' : 'generated-track')
    : 'generated-video'
  return `${String(index + 1).padStart(2, '0')}-${descriptor}${extension}`
}

function normaliseDownloadExtension(url, fallback) {
  try {
    const extension = extname(new URL(url).pathname).toLowerCase()
    return ['.mp3', '.wav', '.m4a', '.flac', '.mp4', '.mov', '.webm'].includes(extension)
      ? extension
      : fallback
  } catch {
    return fallback
  }
}

/** Filesystem-safe default job name for a generation run. */
export function jobNameForGeneration(workflow, now = new Date()) {
  const stamp = now.toISOString().replace(/[:-]/gu, '').replace(/\..+$/u, '').replace('T', '-')
  return `${safeSlug(workflow, 'generation')}-${stamp}`
}

function failedLedgerRecord({ workflow, model, taskId, mode, change, creditsBefore, creditsAfter, started, error, outputs = [], providerUrls = [] }) {
  return {
    kind: 'generation',
    provider: 'kie',
    workflow,
    model,
    mode,
    change,
    taskId,
    state: 'FAILED',
    reason: error?.message ?? String(error),
    outputs: outputs.map((output) => ({ file: basename(output.path), bytes: output.bytes })),
    providerUrls,
    creditsBefore,
    creditsAfter,
    creditsSpent: creditsBefore === null || creditsAfter === null ? null : creditsBefore - creditsAfter,
    elapsedMs: Date.now() - started
  }
}

/**
 * Execute one already-authorized generation task.
 *
 * Dependencies are injectable for offline tests; production uses the real Kie
 * client functions. Execution requires a key, explicit enablement and the cap.
 */
export async function executeGeneration(options = {}, dependencies = {}) {
  const deps = {
    getCredits,
    uploadFile,
    createTask,
    getJobRecord,
    waitForTask,
    downloadToFile,
    appendLedger,
    ...dependencies
  }
  const maxCredits = assertGenerationEnabled({ enabled: options.enabled, maxCredits: options.maxCredits })
  const key = readText(options.key, 'key', { required: true })
  const progress = typeof options.onProgress === 'function' ? options.onProgress : () => {}
  const started = Date.now()

  const plan = await planGeneration({ ...options, enabled: true, maxCredits })
  const outRoot = resolve(options.outDir ?? join(process.cwd(), 'generation'))
  const job = safeSlug(options.job, jobNameForGeneration(plan.workflow))
  const jobDir = join(outRoot, job)
  const outputsDir = join(jobDir, 'outputs')
  const ledgerPath = join(jobDir, 'kie-jobs.jsonl')
  const planPath = join(jobDir, 'generation-plan.json')
  const requestPath = join(jobDir, 'generation-request.json')
  const resultPath = join(jobDir, 'generation-result.json')
  await mkdir(outputsDir, { recursive: true, mode: 0o700 })
  await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8')

  progress({ stage: 'budget', detail: `checking pilot envelope ${plan.budget.totalMaxCredits} credits` })
  const priorSpend = await readPriorGenerationSpend(outRoot)
  if (priorSpend.unknown.length > 0) {
    throw new KieError(
      'GENERATION_BUDGET_UNVERIFIED',
      `cannot establish prior pilot spending: ${priorSpend.unknown.map((entry) => `${entry.job} (${entry.reason})`).join('; ')}`
    )
  }
  const totalBudgetBefore = assertTotalBudgetAvailable({
    priorSpent: priorSpend.spent,
    totalMaxCredits: plan.budget.totalMaxCredits,
    maxCredits
  })

  progress({ stage: 'budget', detail: `checking balance against ${maxCredits} credit cap` })
  const creditsBefore = await deps.getCredits(key)
  assertBudgetAvailable({ creditsBefore, maxCredits })

  const uploads = { audio: null, video: null, image: null, videos: [], images: [] }
  for (let index = 0; index < plan.assets.length; index += 1) {
    const asset = plan.assets[index]
    progress({
      stage: 'upload',
      detail: `${asset.role} ${index + 1}/${plan.assets.length}: ${(asset.bytes / (1024 * 1024)).toFixed(2)} MB`
    })
    const uploaded = await deps.uploadFile(key, asset.path, { uploadPath: `media-generation/${job}` })
    if (asset.role === 'video') {
      uploads.videos.push(uploaded.url)
      uploads.video ??= uploaded.url
    } else if (asset.role === 'image') {
      uploads.images.push(uploaded.url)
      uploads.image ??= uploaded.url
    } else if (asset.role === 'audio') {
      uploads.audio = uploaded.url
    }
  }

  const request = buildWorkflowRequest(plan.workflow, plan.parameters, uploads)
  await writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`, 'utf8')
  progress({ stage: 'task', detail: `creating ${plan.model}` })
  const taskId = await deps.createTask(key, request.model, request.input)

  let record
  try {
    record = await deps.waitForTask(taskId, (id) => deps.getJobRecord(key, id), {
      timeoutMs: options.taskTimeoutMs ?? 900_000,
      intervalMs: options.intervalMs ?? 5_000,
      onProgress: (event) => progress({
        stage: 'task',
        detail: `${event.state} after ${Math.round(event.elapsedMs / 1000)}s`
      })
    })
  } catch (error) {
    const creditsAfter = await deps.getCredits(key).catch(() => null)
    await deps.appendLedger(ledgerPath, failedLedgerRecord({
      workflow: plan.workflow,
      model: request.model,
      taskId,
      mode: plan.mode,
      change: plan.change,
      creditsBefore,
      creditsAfter,
      started,
      error
    }))
    throw error
  }

  const generated = collectGeneratedOutputs(plan.workflow, record)
  if (generated.length === 0) {
    const error = new KieError(
      'GENERATION_RESULT_EMPTY',
      `task ${taskId} succeeded but returned no downloadable ${plan.kind} output`,
      record.raw
    )
    await deps.appendLedger(ledgerPath, failedLedgerRecord({
      workflow: plan.workflow,
      model: request.model,
      taskId,
      mode: plan.mode,
      change: plan.change,
      creditsBefore,
      creditsAfter: await deps.getCredits(key).catch(() => null),
      started,
      error
    }))
    throw error
  }

  progress({ stage: 'download', detail: `${generated.length} output(s)` })
  const outputs = []
  try {
    for (let index = 0; index < generated.length; index += 1) {
      const output = generated[index]
      const extension = normaliseDownloadExtension(output.url, GENERATION_WORKFLOWS[plan.workflow].defaultExtension)
      const suggested = generatedFileName(plan.workflow, index, output.title)
      const path = join(outputsDir, suggested.replace(/\.[^.]+$/u, extension))
      const file = await deps.downloadToFile(output.url, path)
      outputs.push({
        ...output,
        path: file.path,
        bytes: file.bytes
      })
    }
  } catch (error) {
    const creditsAfter = await deps.getCredits(key).catch(() => null)
    await deps.appendLedger(ledgerPath, failedLedgerRecord({
      workflow: plan.workflow,
      model: request.model,
      taskId,
      mode: plan.mode,
      change: plan.change,
      creditsBefore,
      creditsAfter,
      started,
      error,
      outputs,
      providerUrls: generated.map((output) => output.url)
    }))
    throw error
  }

  const creditsAfter = await deps.getCredits(key).catch(() => null)
  const reportedConsumed = record.raw?.creditsConsumed
  const providerCreditsConsumed = reportedConsumed === null || reportedConsumed === undefined || reportedConsumed === ''
    ? null
    : Number.isFinite(Number(reportedConsumed))
      ? Number(reportedConsumed)
      : null
  const balanceDelta = creditsAfter === null ? null : creditsBefore - creditsAfter
  const spent = providerCreditsConsumed ?? balanceDelta
  const budget = evaluateBudget({ spent, maxCredits })
  const totalBudget = evaluateTotalBudget({
    priorSpent: priorSpend.spent,
    spent,
    totalMaxCredits: plan.budget.totalMaxCredits
  })
  const overBudget = budget.ok === false || totalBudget.ok === false
  const result = {
    schema: 'dsh-media-reader/generation-result@1',
    status: overBudget ? 'SUCCESS_OVER_BUDGET' : 'SUCCESS',
    workflow: plan.workflow,
    kind: plan.kind,
    mode: plan.mode,
    change: plan.change,
    model: request.model,
    taskId,
    providerState: record.state,
    outputs,
    providerUrls: generated.map((output) => output.url),
    plan: planPath,
    request: requestPath,
    ledger: ledgerPath,
    credits: {
      cap: maxCredits,
      before: creditsBefore,
      after: creditsAfter,
      providerCreditsConsumed,
      balanceDelta,
      spent,
      withinCap: budget.ok,
      note: budget.note
    },
    pilotBudget: {
      totalMaxCredits: plan.budget.totalMaxCredits,
      priorSpent: priorSpend.spent,
      remainingBefore: totalBudgetBefore.remaining,
      totalSpent: totalBudget.totalSpent,
      withinBudget: totalBudget.ok,
      note: totalBudget.note
    },
    elapsedMs: Date.now() - started,
    generationCall: true,
    note: 'provider output is an approximation; compare it against the evidence pack before acceptance'
  }
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  await deps.appendLedger(ledgerPath, {
    kind: 'generation',
    provider: 'kie',
    workflow: plan.workflow,
    model: request.model,
    mode: plan.mode,
    change: plan.change,
    taskId,
    state: record.state,
    assets: plan.assets.map((asset) => ({ role: asset.role, file: basename(asset.path), bytes: asset.bytes })),
    outputs: outputs.map((output) => ({ file: basename(output.path), bytes: output.bytes })),
    creditsBefore,
    creditsAfter,
    creditsSpent: spent,
    providerCreditsConsumed,
    budgetCap: maxCredits,
    budgetWithinCap: budget.ok,
    pilotBudgetCap: plan.budget.totalMaxCredits,
    pilotPriorSpent: priorSpend.spent,
    pilotTotalSpent: totalBudget.totalSpent,
    pilotWithinBudget: totalBudget.ok,
    elapsedMs: Date.now() - started
  })

  if (overBudget) {
    const detail = budget.ok === false
      ? `task ${taskId} consumed ${spent} credits, above the ${maxCredits} credit task cap`
      : `cumulative pilot spend ${totalBudget.totalSpent} credits is above the ${plan.budget.totalMaxCredits} credit pilot budget`
    const error = new KieError(
      'GENERATION_BUDGET_EXCEEDED',
      `${detail}; output was archived and recorded`
    )
    error.result = result
    throw error
  }
  if (budget.ok === null || totalBudget.ok === null) {
    progress({ stage: 'budget', detail: `${budget.note}; ${totalBudget.note}` })
  }
  progress({ stage: 'done', detail: `${outputs.length} output(s) archived` })
  return { ...result, resultPath }
}
