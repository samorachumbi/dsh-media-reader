/**
 * POST /media-reader/ingest — the host half of drag-and-drop.
 *
 * Raw file bytes in, text analysis out. It is loopback-only, requires the
 * client's marker header, writes the upload to a private temp directory under
 * the artifact root, and removes it after processing.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { MediaError } from './errors.js'
import { isSupportedMediaPath } from './probe.js'
import { ingestUpload } from './upload.js'

const ROUTE = '/media-reader/ingest'
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/u
const DEFAULT_MAX_BYTES = 128 * 1024 * 1024

function json(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  })
  res.end(JSON.stringify(payload))
}

async function readBody(req, maxBytes) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > maxBytes) throw new MediaError('UPLOAD_TOO_LARGE', `upload exceeds ${Math.round(maxBytes / (1024 * 1024))} MB`)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function safeName(raw) {
  let decoded
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    throw new MediaError('INVALID_FILENAME', 'the upload filename is not valid URI encoding')
  }
  const name = basename(decoded).replace(/[^a-zA-Z0-9._ -]+/gu, '_').slice(0, 120)
  if (name.length === 0 || !isSupportedMediaPath(name)) {
    throw new MediaError('UNSUPPORTED_MEDIA', `"${decoded}" is not a supported image/audio/video filename`)
  }
  return name
}

export function registerUploadRoute(ctx, config) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) return
  const maxBytes = config.maxUploadBytes ?? DEFAULT_MAX_BYTES
  const timeoutMs = config.uploadTimeoutMs ?? 600_000

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: ROUTE,
    handler: async (req, res) => {
      try {
        const host = String(req.headers.host ?? '')
        if (!LOOPBACK.test(host)) return json(res, 403, { ok: false, error: 'forbidden host' })
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' })
        if (String(req.headers['x-media-reader-client'] ?? '') !== '1') {
          return json(res, 403, { ok: false, error: 'missing media-reader client marker' })
        }
        const declaredLength = Number(req.headers['content-length'] ?? 0)
        if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
          return json(res, 413, { ok: false, error: `upload exceeds ${Math.round(maxBytes / (1024 * 1024))} MB` })
        }
        const name = safeName(String(req.headers['x-media-reader-name'] ?? ''))
        const questionHeader = req.headers['x-media-reader-question']
        let question
        if (typeof questionHeader === 'string' && questionHeader.length > 0) {
          try {
            question = decodeURIComponent(questionHeader).slice(0, 1_000)
          } catch {
            return json(res, 400, { ok: false, error: 'question is not valid URI encoding' })
          }
        }

        const body = await readBody(req, maxBytes)
        if (body.length === 0) return json(res, 400, { ok: false, error: 'empty upload' })

        const dir = join(config.artifactsDir, 'uploads', randomUUID())
        await mkdir(dir, { recursive: true, mode: 0o700 })
        const filePath = join(dir, name)
        await writeFile(filePath, body, { mode: 0o600 })
        try {
          const result = await ingestUpload(ctx, config, {
            path: filePath,
            name,
            question,
            signal: AbortSignal.timeout(timeoutMs)
          })
          return json(res, 200, { ok: true, name, ...result })
        } finally {
          await rm(dir, { recursive: true, force: true }).catch(() => {})
        }
      } catch (error) {
        if (error instanceof MediaError) {
          const status = error.code === 'UPLOAD_TOO_LARGE' ? 413 : error.code === 'UNSUPPORTED_MEDIA' ? 415 : 422
          return json(res, status, { ok: false, code: error.code, error: error.message })
        }
        return json(res, 500, { ok: false, error: String(error?.message ?? error) })
      }
    }
  }), 'media-reader: drag-and-drop upload route')
}
