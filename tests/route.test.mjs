import test from 'node:test'
import assert from 'node:assert/strict'
import { clearVisionRouteCache, resolveCurrentRoute, resolveVisionRoute } from '../lib/route.js'

function contextWithLlm({ currentProvider = 'p', currentModel = 'text-only', providers = ['p'], models = {} } = {}) {
  return {
    get(name) {
      if (name !== 'llm') return undefined
      return {
        resolveModelInfo: async (provider, model) => ({
          provider,
          id: model,
          inputModalities: model === 'vision' ? ['text', 'image'] : ['text']
        }),
        listProviders: () => providers.map((id) => ({ id, name: id })),
        listModels: async (provider) => (models[provider] ?? []).map((model) => ({
          provider,
          id: model.id,
          inputModalities: model.inputModalities ?? ['text']
        })),
        current: { provider: currentProvider, model: currentModel }
      }
    }
  }
}

test('resolveCurrentRoute reports whether the session route accepts images', async () => {
  const exec = { agent: { options: { provider: 'p', model: 'text-only' } }, signal: undefined }
  const route = await resolveCurrentRoute(contextWithLlm(), exec)
  assert.equal(route.resolved, true)
  assert.equal(route.canSeeImages, false)
})

test('resolveCurrentRoute prefers the session request header over agent options', async () => {
  const exec = {
    agent: {
      options: { provider: 'p', model: 'text-only' },
      session: { requestHeader: () => ({ config: { provider: 'p', model: 'vision' } }) }
    },
    signal: undefined
  }
  const route = await resolveCurrentRoute(contextWithLlm(), exec)
  assert.equal(route.model, 'vision')
  assert.equal(route.canSeeImages, true)
})

test('resolveVisionRoute uses an explicitly configured route and validates its modality', async () => {
  clearVisionRouteCache()
  const route = await resolveVisionRoute(
    contextWithLlm(),
    { visionProvider: 'p', visionModel: 'vision' },
    undefined
  )
  assert.deepEqual(route, { provider: 'p', model: 'vision', source: 'configured' })

  await assert.rejects(
    resolveVisionRoute(contextWithLlm(), { visionProvider: 'p', visionModel: 'text-only' }, undefined),
    (error) => error.code === 'VISION_ROUTE_INVALID'
  )
})

test('resolveVisionRoute discovers a vision-capable model when none is configured', async () => {
  clearVisionRouteCache()
  const ctx = contextWithLlm({
    providers: ['text-provider', 'vision-provider'],
    models: {
      'text-provider': [{ id: 't1' }],
      'vision-provider': [{ id: 't2' }, { id: 'v1', inputModalities: ['text', 'image'] }]
    }
  })
  const route = await resolveVisionRoute(ctx, {}, undefined)
  assert.deepEqual(route, { provider: 'vision-provider', model: 'v1', source: 'discovered' })
})

test('resolveVisionRoute fails loudly when no route can see images', async () => {
  clearVisionRouteCache()
  const ctx = contextWithLlm({ providers: ['p'], models: { p: [{ id: 't1' }] } })
  await assert.rejects(resolveVisionRoute(ctx, {}, undefined), (error) => error.code === 'NO_VISION_ROUTE')
})
