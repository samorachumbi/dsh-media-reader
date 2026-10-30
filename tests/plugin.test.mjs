import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

function fakePluginContext({ textOnly = true, description = 'A red square on a white background.' } = {}) {
  const tools = new Map()
  const listeners = []
  const services = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      }
    },
    fs: {
      resolve: async (requestedPath) => ({ targetKey: requestedPath, displayPath: requestedPath }),
      stat: async () => ({ type: 'file', size: 8 }),
      processPath: (target) => target.targetKey,
      readBytes: async () => Buffer.from('fake-image-bytes')
    },
    attachments: {
      imageLimits: {
        mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
        maxImageBytes: 1_000_000,
        maxMessageImageBytes: 1_000_000
      },
      saveImage: async () => ({
        attachmentId: 'attachment-12345678',
        mediaType: 'image/png',
        bytes: 16,
        width: 320,
        height: 180
      })
    },
    llm: {
      resolveModelInfo: async (_provider, model) => ({
        inputModalities: model === 'vision' ? ['text', 'image'] : ['text']
      }),
      listProviders: () => [{ id: 'test-provider', name: 'test-provider' }],
      listModels: async () => [{ id: 'vision', inputModalities: ['text', 'image'] }],
      async *stream() {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: description }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: description } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
  }
  const ctx = {
    tools: services.tools,
    fs: services.fs,
    get(name) {
      return services[name]
    },
    on(event, listener) {
      listeners.push({ event, listener })
      return () => {}
    }
  }
  return { ctx, tools, listeners }
}

function execFor(model, filePath = '/fixtures/photo.png') {
  return {
    name: 'media_image',
    arguments: { file_path: filePath, path: filePath },
    agent: { options: { provider: 'test-provider', model } },
    signal: new AbortController().signal
  }
}

test('apply registers the Day 1 tools and the read_image redirect listener', () => {
  const { ctx, tools, listeners } = fakePluginContext()
  apply(ctx, { visionProvider: 'test-provider', visionModel: 'vision' })
  assert.deepEqual([...tools.keys()].sort(), ['media_audio', 'media_evidence', 'media_image', 'media_probe', 'media_video'])
  assert.equal(listeners.filter((entry) => entry.event === 'tools/pre-execute').length, 1)
})

test('media_image returns a real image block on a vision route', async () => {
  const { ctx, tools } = fakePluginContext()
  apply(ctx, { visionProvider: 'test-provider', visionModel: 'vision' })
  const result = await tools.get('media_image').execute(
    { path: '/fixtures/photo.png' },
    execFor('vision')
  )
  assert.equal(result.image.mediaType, 'image/png')
  assert.match(result.text, /<type>image<\/type>/u)
  assert.match(result.text, /320x180/u)
})

test('media_image returns a described text result on a text-only route', async () => {
  const { ctx, tools } = fakePluginContext({ textOnly: true, description: 'A blue circle with the word HELLO.' })
  apply(ctx, { visionProvider: 'test-provider', visionModel: 'vision' })
  const result = await tools.get('media_image').execute(
    { path: '/fixtures/photo.png', question: 'What does it say?' },
    execFor('text-only')
  )
  assert.equal(result.image, undefined)
  assert.match(result.text, /<type>image-description<\/type>/u)
  assert.match(result.text, /test-provider\/vision/u)
  assert.match(result.text, /HELLO/u)
})

test('the redirect denies read_image only on a text-only route', async () => {
  const { ctx, listeners } = fakePluginContext()
  apply(ctx, { visionProvider: 'test-provider', visionModel: 'vision' })
  const redirect = listeners.find((entry) => entry.event === 'tools/pre-execute').listener

  const denied = await redirect(
    { name: 'read_image', arguments: { file_path: '/fixtures/photo.png' }, agent: execFor('text-only').agent, signal: undefined },
    async () => ({ kind: 'allow' })
  )
  assert.equal(denied.kind, 'deny')
  assert.match(denied.reason, /media_image/u)

  const allowed = await redirect(
    { name: 'read_image', arguments: { file_path: '/fixtures/photo.png' }, agent: execFor('vision').agent, signal: undefined },
    async () => ({ kind: 'allow' })
  )
  assert.deepEqual(allowed, { kind: 'allow' })
})

test('the redirect ignores other tools and missing file paths', async () => {
  const { ctx, listeners } = fakePluginContext()
  apply(ctx, { visionProvider: 'test-provider', visionModel: 'vision' })
  const redirect = listeners.find((entry) => entry.event === 'tools/pre-execute').listener
  const next = async () => ({ kind: 'allow' })
  assert.deepEqual(await redirect({ name: 'media_probe', arguments: { path: '/x' }, agent: execFor('text-only').agent }, next), { kind: 'allow' })
  assert.deepEqual(await redirect({ name: 'read_image', arguments: {}, agent: execFor('text-only').agent }, next), { kind: 'allow' })
})

test('media_evidence refuses an image path and says where to go instead', async () => {
  const { ctx, tools } = fakePluginContext()
  apply(ctx, { visionProvider: 'test-provider', visionModel: 'vision', evidenceRunner: async () => ({ exitCode: 0, stdout: '', stderr: '' }) })
  await assert.rejects(
    tools.get('media_evidence').execute({ path: '/fixtures/photo.png' }, { ...execFor('vision'), arguments: { path: '/fixtures/photo.png' } }),
    /media_image/u
  )
})

test('media_evidence refuses an unsupported extension before spawning anything', async () => {
  const { ctx, tools } = fakePluginContext()
  let spawned = 0
  apply(ctx, { visionProvider: 'test-provider', visionModel: 'vision', evidenceRunner: async () => { spawned += 1; return { exitCode: 0, stdout: '', stderr: '' } } })
  await assert.rejects(
    tools.get('media_evidence').execute({ path: '/fixtures/notes.txt' }, execFor('vision', '/fixtures/notes.txt')),
    /UNSUPPORTED_MEDIA/u
  )
  assert.equal(spawned, 0, 'nothing may be spawned for a rejected path')
})

test('media_image refuses a non-image path with a named error', async () => {
  const { ctx, tools } = fakePluginContext()
  apply(ctx, { visionProvider: 'test-provider', visionModel: 'vision' })
  await assert.rejects(
    tools.get('media_image').execute({ path: '/fixtures/audio.mp3' }, execFor('vision', '/fixtures/audio.mp3')),
    /UNSUPPORTED_IMAGE/u
  )
})
