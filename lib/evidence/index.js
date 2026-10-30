/**
 * The evidence pack, end to end.
 *
 * Stage 1 of PRODUCTION-PIPELINE.md: measure the source locally, write the
 * artifacts, and make no generation call. It runs as a plain library so the CLI
 * (and later a DSH tool) can share one code path, and it takes a `run` function
 * so it works with or without a harness process seam.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { measureAudio } from './audio.js'
import { readLyrics } from './lyrics.js'
import { buildPack, buildPlan } from './pack.js'
import { renderReplicationMarkdown } from './render.js'
import { buildShotSheet } from './shots.js'
import { readSourceFacts } from './source.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROJECT = resolve(HERE, '..', '..')

export const DEFAULT_PATHS = Object.freeze({
  python: join(PROJECT, '.venv-stt', 'bin', 'python'),
  dspWorker: join(PROJECT, 'python', 'dsp_worker.py'),
  sttWorker: join(PROJECT, 'python', 'stt_worker.py'),
  modelDir: join(PROJECT, 'models'),
  outDir: join(PROJECT, 'replication')
})

/** A filesystem-safe job name from the source filename and the date. */
export function jobNameFor(filePath, now = new Date()) {
  const stem = basename(filePath).replace(/\.[^.]+$/u, '')
  const slug = stem.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 60) || 'job'
  const stamp = now.toISOString().replace(/[-:]/gu, '').replace(/\..+$/u, '').replace('T', '-')
  return `${slug}-${stamp}`
}

async function hasProgram(run, program) {
  try {
    const result = await run(['which', program], { timeoutMs: 10_000, maxOutputBytes: 4096 })
    return result.exitCode === 0 && result.stdout.trim().length > 0
  } catch {
    return false
  }
}

/**
 * Build one evidence pack.
 * @param {object} options
 * @param {Function} options.run process runner
 * @param {string} options.filePath source media file
 * @param {'replica'|'transform'} [options.mode]
 * @param {'local'|'assisted'|'cloud'} [options.profile]
 * @param {string} [options.outDir]
 * @param {string} [options.job]
 * @param {string} [options.python]
 * @param {string} [options.sttModel]
 * @param {number} [options.maxShots]
 * @param {boolean} [options.lyrics]
 * @param {boolean} [options.keepReferenceAudio]
 * @param {number|null} [options.maxAudioSeconds] analysis window; null means the whole file
 * @param {(stage: string, detail?: string) => void} [options.onProgress]
 * @param {AbortSignal} [options.signal]
 */
export async function buildEvidencePack(options) {
  if (typeof options?.run !== 'function') throw new Error('buildEvidencePack requires a run function')
  const filePath = resolve(options.filePath)
  const mode = options.mode ?? 'replica'
  if (!['replica', 'transform'].includes(mode)) throw new Error(`mode must be replica or transform, got ${mode}`)
  const profile = options.profile ?? 'local'
  if (!['local', 'assisted', 'cloud'].includes(profile)) throw new Error(`profile must be local, assisted or cloud, got ${profile}`)

  const run = options.run
  const outDir = resolve(options.outDir ?? DEFAULT_PATHS.outDir)
  const job = options.job ?? jobNameFor(filePath)
  const jobDir = join(outDir, job)
  const progress = options.onProgress ?? (() => {})
  const timings = {}
  const signal = options.signal

  for (const sub of ['frames', 'lyrics', 'reference', 'notes', 'stems']) {
    await mkdir(join(jobDir, sub), { recursive: true, mode: 0o700 })
  }

  progress('source', filePath)
  let started = Date.now()
  const source = await readSourceFacts(run, filePath, { signal })
  timings.source = Date.now() - started
  await writeJson(join(jobDir, 'source.json'), source)

  const ocrAvailable = await hasProgram(run, 'tesseract')

  let audio = null
  if (source.hasAudio) {
    progress('audio', `full duration${options.maxAudioSeconds === undefined ? '' : ` (window ${options.maxAudioSeconds}s)`}`)
    started = Date.now()
    audio = await measureAudio(run, {
      filePath,
      dir: jobDir,
      python: options.python ?? DEFAULT_PATHS.python,
      worker: options.dspWorker ?? DEFAULT_PATHS.dspWorker,
      maxSeconds: options.maxAudioSeconds ?? null,
      keepReferenceAudio: options.keepReferenceAudio !== false,
      signal
    })
    timings.audio = audio.elapsedMs
    await writeJson(join(jobDir, 'audio-features.json'), audio.features)
  } else {
    timings.audio = 0
  }

  let shots = null
  if (source.hasVideo) {
    progress('shots', 'scene detection and frames')
    started = Date.now()
    shots = await buildShotSheet(run, {
      filePath,
      dir: jobDir,
      durationSeconds: source.durationSeconds,
      maxShots: options.maxShots ?? 30,
      sceneThreshold: options.sceneThreshold ?? 10,
      signal
    })
    timings.shots = shots.wallMs
  } else {
    timings.shots = 0
  }

  let lyrics = null
  if (source.hasAudio && options.lyrics !== false) {
    progress('lyrics', `model ${options.sttModel ?? 'base'}`)
    started = Date.now()
    try {
      lyrics = await readLyrics({
        run,
        filePath,
        dir: jobDir,
        displayPath: filePath,
        durationSeconds: source.durationSeconds,
        python: options.python ?? DEFAULT_PATHS.python,
        worker: options.sttWorker ?? DEFAULT_PATHS.sttWorker,
        modelDir: options.modelDir ?? DEFAULT_PATHS.modelDir,
        model: options.sttModel ?? 'base',
        threads: options.sttThreads ?? 4,
        signal
      })
      await writeJson(join(jobDir, 'lyrics', 'lyrics.json'), {
        model: lyrics.transcript.model,
        language: lyrics.transcript.language,
        confidence: lyrics.confidence,
        text: lyrics.transcript.text,
        segments: lyrics.transcript.segments
      })
    } catch (error) {
      lyrics = null
      timings.lyricsError = error.message
    }
    timings.lyrics = timings.lyrics ?? Date.now() - started
  } else {
    timings.lyrics = 0
  }

  const skipped = []
  skipped.push({
    stage: 'stems (Demucs)',
    reason: 'not installed and unmeasured on this 7.6 GB machine; stems stay off by default per PRODUCTION-PIPELINE.md'
  })
  skipped.push({
    stage: 'MIDI (Basic Pitch)',
    reason: 'not installed; the lightweight polyphonic route is planned, not built, so no note-level data is claimed'
  })
  if (!ocrAvailable) {
    skipped.push({ stage: 'OCR (on-screen text)', reason: 'tesseract is not installed on this machine' })
  }
  if (profile === 'local') {
    skipped.push({
      stage: 'semantic pass (genre, vibe, instruments, camera, action)',
      reason: 'profile "local" makes no model call; the assisted and cloud profiles route this to a native audio/video model'
    })
  }
  skipped.push({
    stage: 'generation (Kie)',
    reason: 'this is stage 1: no generation call is made. The adapter is the next build step'
  })
  if (timings.lyricsError !== undefined) {
    skipped.push({ stage: 'lyrics', reason: `transcription failed: ${timings.lyricsError}` })
  }

  progress('pack', 'assembling replication.json')
  const artifacts = {
    jobDir,
    sourceJson: join(jobDir, 'source.json'),
    audioFeaturesJson: audio === null ? null : join(jobDir, 'audio-features.json'),
    framesDir: source.hasVideo ? join(jobDir, 'frames') : null,
    lyricsDir: lyrics === null ? null : join(jobDir, 'lyrics'),
    referenceAudio: audio?.artifacts.referenceAudio?.path ?? null,
    dspWav: audio?.artifacts.dspWav ?? null
  }
  const pack = buildPack({
    source,
    audio,
    shots,
    lyrics,
    mode,
    profile,
    artifacts,
    timings,
    skipped,
    ocrAvailable
  })
  const plan = buildPlan(pack)
  await writeJson(join(jobDir, 'replication.json'), pack)
  await writeJson(join(jobDir, 'plan.json'), plan)
  await writeJson(join(jobDir, 'notes', 'skipped.json'), { skipped, unmeasured: audio?.features?.unmeasured ?? {} })

  progress('render', 'REPLICATION.md')
  const markdown = renderReplicationMarkdown({
    pack,
    plan,
    jobDir,
    sourceName: basename(filePath),
    timings,
    skipped,
    artifacts
  })
  await writeFile(join(jobDir, 'REPLICATION.md'), `${markdown}\n`, 'utf8')

  return {
    job,
    jobDir,
    pack,
    plan,
    source,
    features: audio?.features ?? null,
    shots,
    lyrics,
    timings,
    paths: {
      replicationJson: join(jobDir, 'replication.json'),
      planJson: join(jobDir, 'plan.json'),
      replicationMd: join(jobDir, 'REPLICATION.md'),
      sourceJson: join(jobDir, 'source.json'),
      audioFeaturesJson: join(jobDir, 'audio-features.json'),
      skippedJson: join(jobDir, 'notes', 'skipped.json')
    }
  }
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

