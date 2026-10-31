/**
 * Minimal Kie client: credential, upload, task lifecycle, download, ledger.
 *
 * Deliberately small and loud. Every failure mode that matters here has a name:
 * a missing key, an unreadable upload, a task that fails, a task that never
 * finishes, a provider URL that 404s. None of them may become "no output" —
 * a silently empty stem set or an empty description would be indistinguishable
 * from a real measurement of nothing.
 *
 * The key is never logged, never embedded in an error message, and never written
 * into a ledger row.
 */
import { createReadStream } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'

export const KIE_API = 'https://api.kie.ai'
export const KIE_UPLOAD = 'https://kieai.redpandaai.co/api/file-base64-upload'

export class KieError extends Error {
  constructor(code, message, detail) {
    super(`${code}: ${message}`)
    this.name = 'KieError'
    this.code = code
    this.detail = detail
  }
}

const MIME_BY_EXTENSION = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska'
}

/** Mask a secret for logs: shape and length only. */
export function maskKey(key) {
  if (typeof key !== 'string' || key.length === 0) return '(none)'
  return `${key.slice(0, 3)}…${key.slice(-2)} (${key.length} chars)`
}

/**
 * Resolve the Kie credential.
 *
 * Order: an explicit value, then `KIE_AI_API_KEY` in the environment, then the
 * given env file. The variable is **KIE_AI_API_KEY** — `KIE_API_KEY` does not
 * exist, and two earlier sessions recorded "no credential" because they looked
 * for the wrong name in `process.env` only.
 */
export async function resolveKieKey(options = {}) {
  if (typeof options.key === 'string' && options.key.trim().length > 0) {
    return options.key.trim()
  }
  const fromEnv = process.env.KIE_AI_API_KEY ?? process.env.KIE_API_KEY
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim()
  const envFile = options.envFile
  if (typeof envFile === 'string' && envFile.length > 0) {
    const text = await readFile(envFile, 'utf8').catch(() => null)
    if (text === null) {
      throw new KieError('KIE_KEY_FILE_MISSING', `no Kie env file at ${envFile}`)
    }
    for (const line of text.split(/\r?\n/u)) {
      const match = line.match(/^\s*(KIE_AI_API_KEY|KIE_API_KEY)\s*=\s*(.+?)\s*$/u)
      if (match !== null) return match[2].replace(/^["']|["']$/gu, '')
    }
    throw new KieError(
      'KIE_KEY_MISSING',
      `no KIE_AI_API_KEY line in ${envFile} (the variable is KIE_AI_API_KEY, not KIE_API_KEY)`
    )
  }
  throw new KieError(
    'KIE_KEY_MISSING',
    'no Kie credential: set KIE_AI_API_KEY, or pass --kie-env <file> (for example ' +
    '~/projects/Website_Builder/.env)'
  )
}

async function readJson(response, what) {
  const text = await response.text()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new KieError('KIE_NOT_JSON', `${what} returned a non-JSON body`, text.slice(0, 400))
  }
  return parsed
}

/** One authenticated JSON request against api.kie.ai. */
export async function kieRequest(key, path, { method = 'GET', body, timeoutMs = 120_000, attempts = 3 } = {}) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await kieRequestOnce(key, path, { method, body, timeoutMs })
    } catch (error) {
      lastError = error
      // Only a transient upstream failure is worth retrying. A bad credential, a
      // bad parameter or an empty balance must fail on the first attempt.
      // Two transient shapes: an upstream 5xx code, and a transport-level
      // failure (`fetch failed` / ECONNRESET), which happened mid-run against a
      // healthy endpoint and succeeded on retry.
      const transient = (error?.code === 'KIE_REQUEST_FAILED' && /code 5\d\d/u.test(error.message)) ||
        /fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|network/iu.test(error?.message ?? '')
      if (!transient || attempt === attempts) throw error
      await new Promise((resolve) => setTimeout(resolve, 2_000 * attempt))
    }
  }
  throw lastError
}

async function kieRequestOnce(key, path, { method = 'GET', body, timeoutMs = 120_000 } = {}) {
  const response = await fetch(`${KIE_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs)
  })
  const payload = await readJson(response, `${method} ${path}`)
  // Two legitimate success shapes: `{code: 200}` (jobs API) and an OpenAI-style
  // body with no `code` at all but a `choices` array (gemini chat completions).
  // Comparing strictly against the number 200 rejected a real reply whose code
  // arrived as the string "200" — the failure read as "Kie rejected the request
  // (code 200)", which is nonsense on its face.
  const numericCode = Number(payload?.code)
  const ok = numericCode === 200 || (payload?.code === undefined && Array.isArray(payload?.choices))
  if (!ok) {
    const code = Number.isFinite(numericCode) ? numericCode : response.status
    const hint = code === 401
      ? 'the Kie credential is invalid or missing'
      : code === 402
        ? 'the Kie account has insufficient credits'
        : code === 429
          ? 'Kie rate limit exceeded'
          : 'Kie rejected the request'
    throw new KieError('KIE_REQUEST_FAILED', `${hint} (code ${code}): ${payload?.msg ?? 'no message'}`, payload)
  }
  return payload
}

/** Account credit balance. */
export async function getCredits(key) {
  const payload = await kieRequest(key, '/api/v1/chat/credit')
  const value = Number(payload?.data)
  if (!Number.isFinite(value)) {
    throw new KieError('KIE_CREDITS_UNREADABLE', 'the credit endpoint returned no number', payload)
  }
  return value
}

/**
 * Upload one local file and return its provider URL.
 * The API takes a base64 data URL, so the body grows by ~4/3; that is why the
 * caller must pick a file under the endpoint's limit rather than the master copy.
 */
export async function uploadFile(key, filePath, { uploadPath = 'media-evidence', timeoutMs = 300_000 } = {}) {
  const info = await stat(filePath)
  const extension = extname(filePath).toLowerCase()
  const mime = MIME_BY_EXTENSION[extension]
  if (mime === undefined) {
    throw new KieError('KIE_UPLOAD_UNSUPPORTED', `no MIME type known for ${extension || 'a file without extension'}`)
  }
  const bytes = await readFile(filePath)
  const body = JSON.stringify({
    base64Data: `data:${mime};base64,${bytes.toString('base64')}`,
    uploadPath,
    fileName: filePath.split('/').pop()
  })
  const response = await fetch(KIE_UPLOAD, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body,
    signal: AbortSignal.timeout(timeoutMs)
  })
  const payload = await readJson(response, 'upload')
  const url = payload?.data?.downloadUrl ?? payload?.data?.fileUrl ?? payload?.data?.url
  if (typeof url !== 'string' || !/^https?:\/\//u.test(url)) {
    throw new KieError('KIE_UPLOAD_FAILED', 'upload returned no file URL', payload)
  }
  return { url, bytes: info.size, mime, fileName: filePath.split('/').pop() }
}

/** Create one task and return its id. */
export async function createTask(key, model, input, { timeoutMs = 120_000 } = {}) {
  const payload = await kieRequest(key, '/api/v1/jobs/createTask', {
    method: 'POST',
    body: { model, input },
    timeoutMs
  })
  const taskId = payload?.data?.taskId
  if (typeof taskId !== 'string' || taskId.length === 0) {
    throw new KieError('KIE_NO_TASK_ID', 'createTask returned no taskId', payload)
  }
  return taskId
}

/** Generic market task state (`/api/v1/jobs/recordInfo`). */
export async function getJobRecord(key, taskId) {
  const payload = await kieRequest(key, `/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`)
  const data = payload?.data ?? {}
  const state = String(data.state ?? data.status ?? 'unknown')
  let result = data.resultJson ?? null
  if (typeof result === 'string') {
    try {
      result = JSON.parse(result)
    } catch {
      // keep the string: the caller still needs to see what came back
    }
  }
  const urls = Array.isArray(result?.resultUrls)
    ? result.resultUrls
    : Array.isArray(result?.result_urls)
      ? result.result_urls
      : Array.isArray(result?.urls)
        ? result.urls
        : []
  return { state, raw: data, result, urls, failMessage: data.failMsg ?? data.failCode ?? null }
}

/** Suno stem separation state (`/api/v1/vocal-removal/record-info`). */
export async function getVocalSeparationRecord(key, taskId) {
  const payload = await kieRequest(key, `/api/v1/vocal-removal/record-info?taskId=${encodeURIComponent(taskId)}`)
  const data = payload?.data ?? {}
  const state = String(data.successFlag ?? data.state ?? 'unknown')
  return {
    state,
    raw: data,
    response: data.response ?? null,
    failMessage: data.errorMessage ?? null
  }
}

/**
 * Poll until `read` reports success, failure, or the deadline passes.
 * @param {(taskId: string) => Promise<{state: string}>} read
 */
export async function waitForTask(taskId, read, { timeoutMs = 900_000, intervalMs = 5_000, onProgress } = {}) {
  const started = Date.now()
  let delay = intervalMs
  for (;;) {
    const record = await read(taskId)
    const state = String(record.state ?? '').toLowerCase()
    if (['success', 'succeeded', 'completed'].includes(state)) return record
    if (['fail', 'failed', 'error', 'create_task_failed', 'generate_audio_failed', 'callback_exception'].includes(state)) {
      throw new KieError(
        'KIE_TASK_FAILED',
        `task ${taskId} ended in state ${record.state}${record.failMessage === null ? '' : `: ${record.failMessage}`}`,
        record.raw
      )
    }
    if (Date.now() - started > timeoutMs) {
      throw new KieError('KIE_TASK_TIMEOUT', `task ${taskId} did not finish within ${Math.round(timeoutMs / 1000)}s (last state ${record.state})`)
    }
    onProgress?.({ taskId, state: record.state, elapsedMs: Date.now() - started })
    await new Promise((resolve) => setTimeout(resolve, delay))
    delay = Math.min(Math.round(delay * 1.25), 15_000)
  }
}

/** Download a provider URL to a local path, atomically. */
export async function downloadToFile(url, destPath, { timeoutMs = 300_000 } = {}) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) {
    throw new KieError('KIE_DOWNLOAD_FAILED', `${response.status} for ${url.slice(0, 120)}`)
  }
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.length === 0) {
    throw new KieError('KIE_DOWNLOAD_EMPTY', `provider returned a zero-byte file for ${url.slice(0, 120)}`)
  }
  await mkdir(dirname(destPath), { recursive: true, mode: 0o700 })
  const temporary = `${destPath}.part`
  await writeFile(temporary, buffer)
  await writeFile(destPath, buffer)
  return { path: destPath, bytes: buffer.length }
}

/**
 * Append one row to the job ledger. Every paid call lands here, and no row ever
 * carries the credential.
 */
export async function appendLedger(ledgerPath, record) {
  const row = {
    at: new Date().toISOString(),
    ...record
  }
  delete row.key
  await mkdir(dirname(ledgerPath), { recursive: true, mode: 0o700 })
  await writeFile(ledgerPath, `${JSON.stringify(row)}\n`, { flag: 'a' })
  return row
}

/** True when a path exists and is readable as a file (used before uploads). */
export async function fileSize(path) {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

export { createReadStream, join }
