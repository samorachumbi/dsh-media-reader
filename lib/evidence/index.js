/**
 * The evidence pack, end to end.
 *
 * Stage 1 of PRODUCTION-PIPELINE.md: measure the source locally, write the
 * artifacts, and make no generation call. It runs as a plain library so the CLI
 * (and later a DSH tool) can share one code path, and it takes a `run` function
 * so it works with or without a harness process seam.
 */
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { measureAudio } from './audio.js'
import { identifyChords } from './chords.js'
import { readLyrics } from './lyrics.js'
import { buildPack, buildPlan } from './pack.js'
import { renderReplicationMarkdown } from './render.js'
import { buildShotSheet } from './shots.js'
import { runSemanticPass } from './semantic.js'
import { readSourceFacts } from './source.js'
import { measureStemFile, separateStems } from './stems.js'

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

  // Chords: derived from the measured chroma series, so they need no network.
  let chords = null
  if (audio?.features?.series?.chroma !== undefined) {
    progress('chords', 'triad templates over the measured chroma')
    const flat = audio.features.series.chroma
    const frames = []
    for (let index = 0; index + 12 <= flat.length; index += 12) frames.push(flat.slice(index, index + 12))
    chords = identifyChords(frames, audio.features.series.hopSec ?? 0.5, {
      windowSec: options.chordWindowSec ?? 4,
      // 0.35, matching the module default: the earlier 0.12 let weakly-supported
      // triads (confidence 0.16-0.24) into the pack, which reads as a finding.
      minConfidence: options.chordMinConfidence ?? 0.35
    })
  } else {
    chords = { segments: [], note: 'no chroma series was produced for this source' }
  }

  const shotInventoryPath = source.hasVideo ? join(jobDir, 'shots.json') : null
  if (shots !== null && shotInventoryPath !== null) {
    await writeJson(shotInventoryPath, {
      detected: shots.detected,
      sampled: shots.shots.length,
      cuts: shots.cuts,
      boundaries: shots.boundaries ?? [],
      pilots: shots.pilots ?? null,
      sampling: shots.truncated ? 'budgeted subset' : 'every detected shot'
    })
  }

  // Paid stages: only when the caller explicitly asked for a non-local profile.
  const network = profile !== 'local'
  const ledgerPath = join(jobDir, 'kie-jobs.jsonl')
  let stems = null
  let semantic = null
  const networkNotes = []
  if (network && source.hasAudio && options.stems !== false) {
    progress('stems', 'Kie Suno stem separation')
    started = Date.now()
    try {
      stems = await separateStems({
        run,
        key: options.kieKey,
        filePath,
        dir: jobDir,
        ledgerPath,
        minCredits: options.minCredits,
        signal,
        onProgress: (event) => progress('stems', event.detail)
      })
      progress('stems', `measuring ${stems.stems.length} stems locally`)
      for (const stem of stems.stems) {
        stem.measured = await measureStemFile(run, {
          run,
          dir: jobDir,
          filePath: stem.path,
          label: stem.label,
          python: options.python ?? DEFAULT_PATHS.python,
          worker: options.dspWorker ?? DEFAULT_PATHS.dspWorker,
          signal
        })
      }
    } catch (error) {
      stems = null
      networkNotes.push({ stage: 'stems', reason: error.message })
      timings.stemsError = error.message
    }
    timings.stems = Date.now() - started
  } else {
    timings.stems = 0
  }

  if (network && options.semantic !== false) {
    progress('semantic', 'Kie Gemini 3 Pro with measured facts')
    started = Date.now()
    const frameBudget = options.semanticFrames ?? 6
    // Each frame keeps the shot it belongs to, so the model can be asked about
    // "media item N" and the answer can be mapped back to a real detected shot.
    const frames = (shots?.shots ?? [])
      .filter((shot) => typeof shot.files?.mid === 'string')
      .slice(0, frameBudget)
      .map((shot) => ({
        path: shot.files.mid,
        detectedShot: shot.detectedShot ?? shot.index,
        startSec: shot.startSec,
        endSec: shot.endSec
      }))
    // The audio attachment does not depend on stems succeeding: reuse the encoded
    // upload source if a separation attempt made one, otherwise encode it here.
    let audioForSemantic = options.uploadAudioPath ?? null
    if (audioForSemantic === null) {
      const candidate = join(jobDir, 'stems', 'upload-source.mp3')
      audioForSemantic = existsSync(candidate)
        ? candidate
        : await encodeSemanticAudio(run, filePath, jobDir, { signal })
    }
    try {
      semantic = await runSemanticPass({
        key: options.kieKey,
        dir: jobDir,
        ledgerPath,
        facts: {
          sourceName: basename(filePath),
          durationSeconds: source.durationSeconds,
          tempo: audio?.features?.tempo ?? null,
          key: audio?.features?.key ?? null,
          onsetRate: audio?.features?.onsets?.ratePerSec ?? null,
          loudnessLufs: source.loudness?.integratedLufs ?? null,
          sections: audio?.features?.sections ?? [],
          shots: (shots?.shots ?? []).slice(0, 12).map((shot) => ({
            detectedShot: shot.detectedShot ?? shot.index,
            startSec: shot.startSec,
            endSec: shot.endSec
          }))
        },
        frames,
        audioPath: audioForSemantic,
        minCredits: options.minCredits,
        signal
      })
    } catch (error) {
      semantic = null
      networkNotes.push({ stage: 'semantic pass', reason: error.message })
      timings.semanticError = error.message
    }
    timings.semantic = Date.now() - started
  } else {
    timings.semantic = 0
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
  if (stems === null && profile === 'local') {
    skipped.push({
      stage: 'local stems (Demucs)',
      reason: 'not installed on this machine; the assisted profile uses Kie separation instead, recorded as a skipped stage when it does not run'
    })
  }
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
      reason: 'profile "local" makes no model call; run the assisted profile to add a Kie Gemini interpretation'
    })
    skipped.push({
      stage: 'stems (Kie Suno separation)',
      reason: 'profile "local" uploads nothing; run the assisted profile to separate stems through Kie'
    })
  }
  for (const note of networkNotes) skipped.push(note)
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
    dspWav: audio?.artifacts.dspWav ?? null,
    shotsJson: shotInventoryPath,
    stemsDir: stems === null ? null : join(jobDir, 'stems'),
    kieLedger: network ? ledgerPath : null,
    semanticJson: semantic === null ? null : join(jobDir, 'notes', 'semantic.json')
  }
  const pack = buildPack({
    source,
    audio,
    shots,
    lyrics,
    chords,
    stems,
    semantic,
    mode,
    profile,
    artifacts,
    timings,
    skipped,
    ocrAvailable,
    stemsError: timings.stemsError
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
    chords,
    stems,
    semantic,
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

/**
 * Encode a ≤20 MB MP3 for providers that take a URL rather than bytes.
 * Deliberately separate from the stem path so a failed separation attempt cannot
 * starve the semantic pass of its audio input.
 */
async function encodeSemanticAudio(run, filePath, jobDir, { signal } = {}) {
  const target = join(jobDir, 'notes', 'upload-source.mp3')
  const result = await run(
    ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', filePath,
      '-vn', '-ac', '2', '-ar', '44100', '-b:a', '128k', target],
    { timeoutMs: 600_000, signal, maxOutputBytes: 256 * 1024 }
  )
  if (result.exitCode !== 0) {
    throw new Error(`could not encode the semantic audio upload: ${result.stderr.trim().slice(-200)}`)
  }
  return target
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

