/**
 * Resolve which model route is handling the current call, and which route may
 * describe an image when that route cannot see one.
 */
import { MediaError } from './errors.js'

const VISION_CACHE_MS = 60_000

let visionCache = null

/** Reset the discovery cache (tests and config changes). */
export function clearVisionRouteCache() {
  visionCache = null
}

/**
 * The current call's route and whether it declares image input.
 * @param {object} ctx plugin context
 * @param {object} exec tool execution
 * @returns {Promise<{provider: string|undefined, model: string|undefined, canSeeImages: boolean, resolved: boolean, reason?: string}>}
 */
export async function resolveCurrentRoute(ctx, exec) {
  const routed = exec.agent?.session?.requestHeader?.()?.config
  const provider = routed?.provider ?? exec.agent?.options?.provider
  const model = routed?.model ?? exec.agent?.options?.model
  const llm = ctx.get('llm')
  if (provider === undefined || model === undefined || llm === undefined) {
    return {
      provider,
      model,
      canSeeImages: false,
      resolved: false,
      reason: 'the current model route could not be resolved'
    }
  }
  const info = await llm.resolveModelInfo(provider, model, exec.signal)
  return {
    provider,
    model,
    canSeeImages: info.inputModalities?.includes('image') === true,
    resolved: true,
    inputModalities: info.inputModalities
  }
}

/**
 * Resolve the configured route that can describe images, or discover one from
 * the registered provider catalogs. Cached briefly because it may list models.
 * @param {object} ctx plugin context
 * @param {{visionProvider?: string, visionModel?: string}} config
 * @param {AbortSignal|undefined} signal
 * @returns {Promise<{provider: string, model: string, source: 'configured'|'discovered'}>}
 */
export async function resolveVisionRoute(ctx, config, signal) {
  if (typeof config.visionProvider === 'string' && typeof config.visionModel === 'string') {
    const llm = ctx.get('llm')
    if (llm === undefined) throw new MediaError('NO_LLM', 'the harness LLM service is not mounted')
    const info = await llm.resolveModelInfo(config.visionProvider, config.visionModel, signal)
    if (info.inputModalities?.includes('image') !== true) {
      throw new MediaError(
        'VISION_ROUTE_INVALID',
        `configured vision route ${config.visionProvider}/${config.visionModel} does not declare image input`
      )
    }
    return { provider: config.visionProvider, model: config.visionModel, source: 'configured' }
  }

  const now = Date.now()
  if (visionCache !== null && now - visionCache.at < VISION_CACHE_MS) return visionCache.route

  const llm = ctx.get('llm')
  if (llm === undefined) throw new MediaError('NO_LLM', 'the harness LLM service is not mounted')

  for (const providerInfo of llm.listProviders()) {
    const provider = providerInfo.id ?? providerInfo.provider
    if (typeof provider !== 'string') continue
    let models
    try {
      models = await llm.listModels(provider)
    } catch {
      continue
    }
    for (const model of models) {
      if (model.inputModalities?.includes('image') === true) {
        const route = { provider, model: model.id, source: 'discovered' }
        visionCache = { at: now, route }
        return route
      }
    }
  }

  throw new MediaError(
    'NO_VISION_ROUTE',
    'no registered model route declares image input; configure visionProvider/visionModel or switch to an image-capable model'
  )
}
