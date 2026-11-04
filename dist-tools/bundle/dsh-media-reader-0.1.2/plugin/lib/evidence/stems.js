/**
 * Stem separation through Kie (Suno `ai-music-api/separate-vocals`).
 *
 * Why cloud stems instead of local Demucs: Demucs is unmaintained and unmeasured
 * on this 7.6 GB machine, while Kie already returns up to 12 named stems for one
 * paid call. The trade is that the upload leaves the machine — so this module
 * refuses to run unless the caller explicitly chose a non-local profile.
 *
 * Upload rules that cost real attempts if ignored: the endpoint takes an
 * `audio_url`, not bytes, and the file must be **≤ 20 MB**. The archived lossless
 * FLAC is ~60 MB, so the upload source is a dedicated MP3 encode, and its size is
 * checked before any credit is spent.
 */
import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  appendLedger,
  createTask,
  downloadToFile,
  getCredits,
  getVocalSeparationRecord,
  KieError,
  uploadFile,
  waitForTask
} from '../kie/client.js'

export const STEM_MODEL = 'ai-music-api/separate-vocals'
export const UPLOAD_LIMIT_BYTES = 20 * 1024 * 1024

/** Field name on the Suno response → stem label used on disk. */
export const STEM_FIELDS = Object.freeze({
  vocalUrl: 'Vocals',
  backingVocalsUrl: 'Backing Vocals',
  drumsUrl: 'Drums',
  bassUrl: 'Bass',
  guitarUrl: 'Guitar',
  pianoUrl: 'Piano',
  keyboardUrl: 'Keyboard',
  percussionUrl: 'Percussion',
  stringsUrl: 'Strings',
  synthUrl: 'Synth',
  fxUrl: 'FX',
  brassUrl: 'Brass',
  woodwindsUrl: 'Woodwinds'
})

/** Turn the Suno separation response into a named stem list. */
export function extractStems(response) {
  if (response === null || typeof response !== 'object') return []
  const stems = []
  for (const [field, label] of Object.entries(STEM_FIELDS)) {
    const url = response[field]
    if (typeof url === 'string' && /^https?:\/\//u.test(url)) {
      stems.push({ label, field, url })
    }
  }
  // originData carries the same tracks in list form; use it only to fill gaps.
  if (Array.isArray(response.originData)) {
    for (const entry of response.originData) {
      const url = entry?.audio_url
      const label = entry?.stem_type_group_name
      if (typeof url !== 'string' || typeof label !== 'string') continue
      if (stems.some((stem) => stem.url === url)) continue
      if (stems.some((stem) => stem.label.toLowerCase() === label.toLowerCase())) continue
      stems.push({ label, field: 'originData', url, durationSec: Number(entry.duration) || null })
    }
  }
  return stems
}

/** A filesystem-safe stem file name. */
export function stemFileName(label, index) {
  const slug = String(label).toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '')
  return `${String(index + 1).padStart(2, '0')}-${slug || 'stem'}.mp3`
}

/**
 * Encode an upload-friendly MP3 under the endpoint limit.
 * Tries 192 kbps, then 128, then 96 — and refuses rather than uploading a file
 * the endpoint will reject.
 */
async function encodeUploadSource(run, filePath, dir, timeoutMs) {
  const target = join(dir, 'upload-source.mp3')
  for (const bitrate of ['192k', '128k', '96k']) {
    const result = await run(
      [
        'ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
        '-i', filePath, '-vn', '-ac', '2', '-ar', '44100', '-b:a', bitrate,
        target
      ],
      { timeoutMs, maxOutputBytes: 256 * 1024 }
    )
    if (result.exitCode !== 0) {
      throw new KieError('STEM_ENCODE_FAILED', `ffmpeg could not encode the upload source: ${result.stderr.trim().slice(-200)}`)
    }
    const size = (await stat(target)).size
    if (size <= UPLOAD_LIMIT_BYTES) return { path: target, bytes: size, bitrate }
  }
  const size = (await stat(target)).size
  throw new KieError(
    'STEM_UPLOAD_TOO_LARGE',
    `even 96 kbps produced ${(size / (1024 * 1024)).toFixed(1)} MB, above the 20 MB limit; shorten the source first`
  )
}

/**
 * Separate one source into stems.
 *
 * @param {object} options
 * @param {Function} options.run process runner (ffmpeg)
 * @param {string} options.key Kie credential
 * @param {string} options.filePath media file to separate
 * @param {string} options.dir job directory (stems are written under `stems/`)
 * @param {string} options.ledgerPath kie-jobs.jsonl
 * @param {number} [options.minCredits] abort before spending below this balance
 * @param {(event: object) => void} [options.onProgress]
 * @param {AbortSignal} [options.signal]
 */
export async function separateStems(options) {
  const started = Date.now()
  const stemsDir = join(options.dir, 'stems')
  const timeoutMs = options.timeoutMs ?? 600_000
  const progress = options.onProgress ?? (() => {})

  progress({ stage: 'stems', detail: 'encoding upload source' })
  const upload = await encodeUploadSource(options.run, options.filePath, stemsDir, timeoutMs)

  const creditsBefore = await getCredits(options.key)
  if (Number.isFinite(options.minCredits) && creditsBefore < options.minCredits) {
    throw new KieError(
      'KIE_INSUFFICIENT_CREDITS',
      `balance ${creditsBefore} is below the required floor ${options.minCredits}; no task was created`
    )
  }

  progress({ stage: 'stems', detail: `uploading ${(upload.bytes / (1024 * 1024)).toFixed(1)} MB` })
  const hosted = await uploadFile(options.key, upload.path)

  progress({ stage: 'stems', detail: 'creating separation task' })
  const taskId = await createTask(options.key, STEM_MODEL, {
    audio_url: hosted.url,
    type: 'split_stem'
  })

  let record
  try {
    record = await waitForTask(taskId, (id) => getVocalSeparationRecord(options.key, id), {
      timeoutMs: options.taskTimeoutMs ?? 900_000,
      intervalMs: options.intervalMs ?? 5_000,
      onProgress: (event) => progress({ stage: 'stems', detail: `${event.state} after ${Math.round(event.elapsedMs / 1000)}s` })
    })
  } catch (error) {
    // A failed task is still a submitted task: it belongs in the ledger, with the
    // provider's own reason, even though it cost nothing.
    await appendLedger(options.ledgerPath, {
      kind: 'stem-separation',
      provider: 'kie',
      model: STEM_MODEL,
      taskId,
      state: 'FAILED',
      reason: error.message,
      input: { audioUrl: hosted.url, type: 'split_stem', uploadBytes: upload.bytes },
      creditsBefore,
      creditsAfter: await getCredits(options.key).catch(() => null),
      elapsedMs: Date.now() - started
    })
    throw error
  }

  const stems = extractStems(record.response)
  if (stems.length === 0) {
    throw new KieError('STEM_RESULT_EMPTY', 'separation succeeded but returned no stem URLs', record.raw)
  }

  progress({ stage: 'stems', detail: `downloading ${stems.length} stems` })
  const downloaded = []
  for (let index = 0; index < stems.length; index += 1) {
    const stem = stems[index]
    const path = join(stemsDir, stemFileName(stem.label, index))
    const file = await downloadToFile(stem.url, path)
    downloaded.push({
      label: stem.label,
      path: file.path,
      bytes: file.bytes,
      durationSec: stem.durationSec ?? null
    })
  }

  const creditsAfter = await getCredits(options.key).catch(() => null)
  const elapsedMs = Date.now() - started
  await appendLedger(options.ledgerPath, {
    kind: 'stem-separation',
    provider: 'kie',
    model: STEM_MODEL,
    taskId,
    input: { audioUrl: hosted.url, type: 'split_stem', uploadBytes: upload.bytes, uploadBitrate: upload.bitrate },
    state: record.state,
    stems: downloaded.map((stem) => ({ label: stem.label, bytes: stem.bytes, file: stem.path.split('/').pop() })),
    creditsBefore,
    creditsAfter,
    creditsSpent: creditsAfter === null ? null : creditsBefore - creditsAfter,
    elapsedMs
  })

  return {
    provider: 'kie',
    model: STEM_MODEL,
    taskId,
    uploadSource: upload,
    stems: downloaded,
    creditsBefore,
    creditsAfter,
    elapsedMs,
    note: 'stems are provider-separated approximations, not the original multitrack'
  }
}

/** Measure stems without re-running the whole pack (used by the orchestrator). */
export async function listStemFiles(dir) {
  const stemsDir = join(dir, 'stems')
  const entries = await readdir(stemsDir).catch(() => [])
  return entries.filter((name) => name.endsWith('.mp3') && !name.startsWith('upload-source')).sort()
    .map((name) => join(stemsDir, name))
}

export { stat }

/**
 * Measure one separated stem with the same DSP worker used on the mix.
 *
 * This is what turns "the provider returned a Drum stem" into a fact about the
 * audio: its own tempo, key and energy, measured locally after download.
 */
export async function measureStemFile(run, options) {
  const { parseDspOutput } = await import('./audio.js')
  const workDir = join(options.dir, 'stems', '.work')
  const wav = join(workDir, `${options.label.replace(/[^a-z0-9]+/giu, '-').toLowerCase()}.wav`)
  const timeoutMs = options.timeoutMs ?? 600_000
  try {
    const decode = await run(
      ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', options.filePath,
        '-vn', '-ac', '1', '-ar', '22050', '-c:a', 'pcm_s16le', wav],
      { timeoutMs, signal: options.signal, maxOutputBytes: 256 * 1024 }
    )
    if (decode.exitCode !== 0) {
      return { error: `ffmpeg could not decode this stem: ${decode.stderr.trim().slice(-160)}` }
    }
    const result = await run(
      [options.python, options.worker, '--audio', wav],
      { timeoutMs: Math.max(timeoutMs, 900_000), signal: options.signal, maxOutputBytes: 16 * 1024 * 1024 }
    )
    const features = parseDspOutput(result.stdout)
    return {
      energyRmsDb: features?.energy?.rmsDb ?? null,
      tempo: features?.tempo?.bpm ?? null,
      tempoConfidence: features?.tempo?.confidence ?? null,
      key: features?.key === null || features?.key === undefined ? null : `${features.key.tonic} ${features.key.mode}`,
      keyMargin: features?.key?.margin ?? null,
      onsetsPerSec: features?.onsets?.ratePerSec ?? null,
      harmonicRatio: features?.timbre?.harmonicPercussiveRatio ?? null,
      silent: features?.silent === true
    }
  } finally {
    await rm(wav, { force: true }).catch(() => {})
  }
}
