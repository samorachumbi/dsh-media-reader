#!/usr/bin/env node
/**
 * Smoke-test dsh-media-reader against a RUNNING scratch DSH instance.
 *
 * It drives the real session API — the same calls the Web UI makes — so a pass
 * means the plugin is composed, its tools are registered, its routes resolve,
 * and the local STT/ffmpeg path works. It never touches the live server on 3080.
 *
 *   DSH_TEST_URL=http://127.0.0.1:3096 node probe/smoke.mjs
 *
 * The scratch home must have working model credentials; the script does not
 * read, copy or print any credential.
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
// Fixtures live beside the plugin in the repo (fixtures/) and inside the plugin in a distributed bundle
// (plugin/fixtures/). Resolve both, and let FIXTURES_DIR override for an unusual layout.
const FIXTURE_DIR = process.env.FIXTURES_DIR
  ? process.env.FIXTURES_DIR
  : [join(ROOT, 'fixtures'), join(ROOT, 'plugin', 'fixtures')].find((dir) => existsSync(join(dir, 'hello.png'))) ??
    join(ROOT, 'fixtures')
const BASE = process.env.DSH_TEST_URL ?? 'http://127.0.0.1:3096'
const VISION_MODEL = process.env.DSH_VISION_MODEL ?? 'deepseek-v4-flash-vision-exp'
const TEXT_MODEL = process.env.DSH_TEXT_MODEL ?? 'deepseek-v4-flash'
let rpc = 0

function fixture(name) {
  return join(FIXTURE_DIR, name)
}

async function api(method, payload) {
  const response = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: `smoke-${++rpc}`, method, payload })
  })
  const body = await response.json().catch(() => ({}))
  if (body?.result?.ok !== true) {
    const error = body?.result?.error
    throw new Error(`${method}: ${error?.message ?? `HTTP ${response.status}`}`)
  }
  return body.result.value
}

async function history(sessionId) {
  const value = await api('session.history', { sessionId })
  return Array.isArray(value?.events) ? value.events : []
}

function maxTurn(events) {
  let turn = 0
  for (const entry of events) {
    const event = entry.event
    if (event?.type?.startsWith('turn/')) turn = Math.max(turn, event.data?.turn ?? 0)
  }
  return turn
}

async function runPrompt(sessionId, text, timeoutMs = 180_000) {
  const before = await history(sessionId)
  const lastTurn = maxTurn(before)
  await api('session.prompt', {
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text }]
  })
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const events = await history(sessionId)
    if (events.some((entry) => entry.event?.type === 'turn/end' && (entry.event.data?.turn ?? 0) > lastTurn)) {
      // Only the turn just run: older image results must not satisfy a later
      // text-only check (a whole-history search false-passed once).
      return events.filter((entry) => (entry.event?.data?.turn ?? 0) > lastTurn)
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500))
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for the turn to end`)
}

function callNames(events) {
  const names = new Map()
  for (const entry of events) {
    const event = entry.event
    if (event?.type === 'tool/call') names.set(event.data.callId, event.data.name)
  }
  return names
}

function results(events) {
  const names = callNames(events)
  const out = []
  for (const entry of events) {
    const event = entry.event
    if (event?.type !== 'tool/result') continue
    const block = event.data?.message?.content?.find?.((part) => part.type === 'tool-result')
    if (block === undefined) continue
    const content = block.content ?? []
    out.push({
      name: names.get(block.toolCallId) ?? 'unknown',
      isError: block.isError === true,
      text: content.filter((part) => part.type === 'text').map((part) => part.text).join('\n'),
      images: content.filter((part) => part.type === 'image').length
    })
  }
  return out
}

function assistantText(events) {
  const chunks = []
  for (const entry of events) {
    const event = entry.event
    if (event?.type !== 'assistant/message') continue
    for (const part of event.data?.message?.content ?? []) {
      if (part.type === 'text') chunks.push(part.text)
    }
  }
  return chunks.join('\n')
}

const checks = []
function check(name, condition, detail) {
  checks.push({ name, ok: condition === true, detail })
  console.log(`${condition === true ? 'PASS' : 'FAIL'}  ${name}${condition === true ? '' : `\n      ${detail ?? ''}`}`)
  if (condition !== true) throw new Error(name)
}

async function main() {
  console.log(`smoke target: ${BASE}`)
  const session = await api('session.create', { cwd: ROOT })
  const sessionId = session.sessionId
  console.log(`session: ${sessionId}`)

  await api('session.selectModel', { sessionId, provider: 'deepseek-official', model: VISION_MODEL })
  let events = await runPrompt(
    sessionId,
    `Call media_probe once on ${fixture('error-demo.mp4')}. Report the duration and audio-track count.`
  )
  let text = results(events).map((result) => result.text).join('\n')
  check('media_probe reads duration and audio tracks', /"durationSeconds": 11/u.test(text) && /"audioTracks": 1/u.test(text), text.slice(0, 600))
  check('media_probe reports video dimensions', /"width": 640/u.test(text) && /"height": 360/u.test(text), text.slice(0, 600))

  events = await runPrompt(
    sessionId,
    `Call media_image once on ${fixture('hello.png')} and tell me the exact text in the image.`
  )
  const imageResult = results(events).find((result) => result.name === 'media_image')
  check('vision route receives a real image block', imageResult?.images === 1, JSON.stringify(imageResult ?? {}).slice(0, 600))
  check('vision route can read the image text', /HELLO MEDIA/u.test(assistantText(events)), assistantText(events).slice(0, 600))

  await api('session.selectModel', { sessionId, provider: 'deepseek-official', model: TEXT_MODEL })

  events = await runPrompt(
    sessionId,
    `Call media_image once on ${fixture('hello.png')} and quote the description text.`
  )
  const described = results(events).find((result) => result.name === 'media_image')
  check('text-only route returns an image description', /<type>image-description<\/type>/u.test(described?.text ?? ''), described?.text?.slice(0, 800))
  check('text-only description contains the image text', /HELLO MEDIA/u.test(described?.text ?? ''), described?.text?.slice(0, 800))
  check('text-only route did not receive an image block', described?.images === 0, JSON.stringify(described ?? {}).slice(0, 400))

  events = await runPrompt(sessionId, `Call read_image once on ${fixture('hello.png')} and quote the error.`)
  const redirect = results(events).find((result) => result.name === 'read_image')
  check('read_image is redirected to media_image', redirect?.isError === true && /media_image/u.test(redirect.text), redirect?.text?.slice(0, 800))

  events = await runPrompt(sessionId, `Call media_audio once on ${fixture('jfk.wav')} and quote the transcript.`)
  const audio = results(events).find((result) => result.name === 'media_audio')
  check('audio is transcribed locally', /<type>audio-transcript<\/type>/u.test(audio?.text ?? '') && /fellow Americans/u.test(audio?.text ?? ''), audio?.text?.slice(0, 1_000))
  check('audio result names the local processor', /faster-whisper/u.test(audio?.text ?? ''), audio?.text?.slice(0, 400))

  events = await runPrompt(
    sessionId,
    `Call media_video once on ${fixture('error-demo.mp4')} with mode=digest and the question "What error number is shown on screen?" Quote the visual evidence and the said line.`
  )
  const video = results(events).find((result) => result.name === 'media_video')
  check('video digest answers the visual question', /ERROR 42/u.test(video?.text ?? ''), video?.text?.slice(0, 1_200))
  check('video digest fuses the spoken transcript', /fellow Americans/u.test(video?.text ?? ''), video?.text?.slice(0, 1_200))
  check('text-only video returns no image blocks', video?.images === 0, JSON.stringify(video ?? {}).slice(0, 400))

  events = await runPrompt(sessionId, `Call media_audio once on ${fixture('silence.wav')} and quote the result.`)
  const silence = results(events).find((result) => result.name === 'media_audio')
  check('silence is reported as no speech', /no speech detected/u.test(silence?.text ?? ''), silence?.text?.slice(0, 600))

  events = await runPrompt(sessionId, `Call media_probe once on ${fixture('missing.png')} and quote the error.`)
  const missing = results(events).find((result) => result.name === 'media_probe')
  check('missing file fails explicitly', missing?.isError === true && /NOT_FOUND/u.test(missing.text), missing?.text?.slice(0, 600))

  async function upload(name) {
    const body = await readFile(fixture(name))
    const response = await fetch(`${BASE}/media-reader/ingest`, {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-media-reader-client': '1',
        'x-media-reader-name': encodeURIComponent(name)
      },
      body
    })
    return response.json()
  }

  const uploadedImage = await upload('hello.png')
  check('drop upload describes an image', uploadedImage?.ok === true && /HELLO MEDIA/u.test(uploadedImage.text ?? ''), JSON.stringify(uploadedImage).slice(0, 800))
  const uploadedAudio = await upload('jfk.wav')
  check('drop upload transcribes audio', uploadedAudio?.ok === true && /fellow Americans/u.test(uploadedAudio.text ?? ''), JSON.stringify(uploadedAudio).slice(0, 800))
  const uploadedVideo = await upload('error-demo.mp4')
  check('drop upload digests video', uploadedVideo?.ok === true && /ERROR 42/u.test(uploadedVideo.text ?? '') && /fellow Americans/u.test(uploadedVideo.text ?? ''), JSON.stringify(uploadedVideo).slice(0, 1_000))

  console.log(`\n${checks.length}/${checks.length} checks passed against ${BASE}`)
  console.log(`session: ${sessionId}`)
}

main().catch((error) => {
  console.error(`\nSMOKE FAILED: ${error.message}`)
  process.exitCode = 1
})
