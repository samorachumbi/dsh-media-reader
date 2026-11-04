#!/usr/bin/env node
/**
 * End-to-end check of the drag-and-drop route's text, on a real pipeline.
 *
 * This exists because the unit tests can only prove the two text builders are
 * correct. The claim a buyer cares about is about the *route*: POST the bytes,
 * get the text that would be inserted into the composer draft, and find no
 * absolute host path in it. So this probe invokes the real route handler with
 * the real ffmpeg / faster-whisper pipeline and only two stands-in seams:
 *
 *   - `subprocess` is a local adapter over node:child_process (the harness seam
 *     is not bootable outside a running DSH server);
 *   - `llm` is a fixed description, because the assertion is about paths, not
 *     about what a vision model says.
 *
 * What it does NOT prove: anything about a live DSH server, the browser, or the
 * client's insertion. Those need an install + restart.
 *
 *   node probe/verify-draft-paths.mjs
 */
import { spawn } from 'node:child_process'
import { readFile, mkdtemp, rm, stat as statFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/u, '')
const { registerUploadRoute } = await import(`${REPO}/lib/upload-route.js`)
const { normalizeConfig } = await import(`${REPO}/lib/index.js`)

const DESCRIPTION = 'A single frame with a white background and black text reading ERROR 42.'

function subprocessSeam() {
  return {
    spawn({ argv, cwd, signal }) {
      const child = spawn(argv[0], argv.slice(1), { cwd, stdio: ['ignore', 'pipe', 'pipe'], signal })
      const out = []
      const err = []
      child.stdout.on('data', (chunk) => out.push(chunk))
      child.stderr.on('data', (chunk) => err.push(chunk))
      const done = new Promise((settle) => {
        child.on('error', () => settle({ exitCode: 1 }))
        child.on('close', (exitCode) => settle({ exitCode }))
      })
      return {
        done,
        collected: {
          stdout: { readFrom: () => ({ text: Buffer.concat(out).toString('utf8') }) },
          stderr: { readFrom: () => ({ text: Buffer.concat(err).toString('utf8') }) }
        }
      }
    }
  }
}

function fsSeam() {
  return {
    resolve: async (requestedPath, options = {}) => {
      const targetKey = isAbsolute(requestedPath)
        ? resolve(requestedPath)
        : resolve(options.cwd ?? process.cwd(), requestedPath)
      return { targetKey, displayPath: requestedPath }
    },
    stat: async (target) => {
      try {
        const info = await statFile(target.targetKey)
        return { type: info.isFile() ? 'file' : 'directory', size: info.size }
      } catch {
        return undefined
      }
    },
    processPath: (target) => target.targetKey,
    readBytes: async (target) => readFile(target.targetKey)
  }
}

function llmSeam() {
  return {
    resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }),
    listProviders: () => [{ id: 'probe-provider', name: 'probe-provider' }],
    listModels: async () => [{ id: 'probe-vision', inputModalities: ['text', 'image'] }],
    async *stream() {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: DESCRIPTION }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: DESCRIPTION } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

function parseArtifacts(text) {
  const match = /<artifacts>(.*?)<\/artifacts>/su.exec(text)
  return match === null ? null : JSON.parse(match[1])
}

function absolutePathsIn(text) {
  return [...text.matchAll(/(?:^|["'\s:=(,])(\/[A-Za-z0-9._-]+\/[A-Za-z0-9._\-/]*)/gu)].map((m) => m[1])
}

/** POST one file through the real route handler. */
async function ingest(handler, name, filePath) {
  const body = await readFile(filePath)
  const req = {
    method: 'POST',
    headers: {
      host: '127.0.0.1:3999',
      'x-media-reader-client': '1',
      'x-media-reader-name': encodeURIComponent(name),
      'content-length': String(body.length)
    },
    async *[Symbol.asyncIterator]() {
      yield body
    }
  }
  const res = {
    statusCode: 0,
    payload: null,
    writeHead(status) {
      this.statusCode = status
    },
    end(text) {
      this.payload = JSON.parse(text)
    }
  }
  await handler(req, res)
  return { status: res.statusCode, payload: res.payload }
}

const failures = []
function check(condition, detail) {
  if (!condition) failures.push(detail)
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${detail}`)
}

const artifactsDir = await mkdtemp(join(tmpdir(), 'mr-route-probe-'))
const config = normalizeConfig({
  artifactsDir,
  visionProvider: 'probe-provider',
  visionModel: 'probe-vision',
  sttModel: 'base'
})

let handler
const ctx = {
  fs: fsSeam(),
  get(name) {
    if (name === 'subprocess') return subprocessSeam()
    if (name === 'llm') return llmSeam()
    if (name === 'webServer') {
      return {
        register(route) {
          handler = route.handler
          return () => {}
        }
      }
    }
    if (name === 'attachments') {
      return {
        imageLimits: {
          mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
          maxImageBytes: 8_000_000,
          maxMessageImageBytes: 16_000_000
        },
        saveImage: async () => ({
          attachmentId: 'attachment-probe-1',
          mediaType: 'image/png',
          bytes: 1234,
          width: 800,
          height: 450
        })
      }
    }
    return undefined
  },
  effect(fn) {
    fn()
  },
  on() {
    return () => {}
  }
}

registerUploadRoute(ctx, config)
check(typeof handler === 'function', 'the ingest route registered a handler')

try {
  for (const [name, file] of [
    ['jfk.wav', join(REPO, 'fixtures', 'jfk.wav')],
    ['error-demo.mp4', join(REPO, 'fixtures', 'error-demo.mp4')]
  ]) {
    console.log(`\n--- ${name} (${file})`)
    const { status, payload } = await ingest(handler, name, file)
    check(status === 200 && payload?.ok === true, `${name}: HTTP 200 with ok:true (got ${status} ${JSON.stringify(payload?.error ?? '')})`)
    if (status !== 200 || payload?.ok !== true) continue

    const text = payload.text ?? ''
    const leaked = absolutePathsIn(text)
    check(leaked.length === 0, `${name}: no absolute path in the inserted text (found ${leaked.length}${leaked.length > 0 ? `: ${leaked[0]}` : ''})`)
    check(!text.includes(process.env.HOME ?? '\u0000'), `${name}: the home directory does not appear in the text`)
    check(text.includes('artifact paths are relative to the configured artifacts directory'), `${name}: the text explains how to use the references`)

    const artifacts = parseArtifacts(text)
    check(artifacts !== null, `${name}: the text still publishes an <artifacts> element`)
    if (artifacts === null) continue

    // Every reference must name a file that exists, resolved the way the tools resolve it.
    const references = Object.values(artifacts).flatMap((value) => (Array.isArray(value) ? value : [value]))
    check(references.length > 0, `${name}: ${references.length} artifact reference(s) published`)
    for (const reference of references) {
      check(!isAbsolute(reference), `${name}: ${reference} is relative`)
      const onDisk = join(artifactsDir, reference)
      let exists = true
      try {
        await statFile(onDisk)
      } catch {
        exists = false
      }
      check(exists, `${name}: ${reference} exists on disk (${onDisk})`)
    }
  }
} finally {
  await rm(artifactsDir, { recursive: true, force: true })
}

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`}`)
process.exit(failures.length === 0 ? 0 : 1)
