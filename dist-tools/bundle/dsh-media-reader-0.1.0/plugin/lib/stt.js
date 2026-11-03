/**
 * Bridge to the local faster-whisper worker.
 *
 * Audio never leaves the machine. A missing venv/model, a worker crash, or an
 * unparseable reply is a named failure — never an empty transcript.
 */
import { rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureArtifactDir, withMediaLock, writeTranscriptArtifacts } from './artifacts.js'
import { MediaError } from './errors.js'
import { runProcess } from './exec.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_WORKER = join(HERE, '..', 'python', 'stt_worker.py')

export function defaultSttPython() {
  return process.env.DSH_MEDIA_STT_PYTHON ?? join(homedir(), 'projects', 'Video_Image_Voice', '.venv-stt', 'bin', 'python')
}

export function defaultModelDir() {
  return process.env.DSH_MEDIA_MODEL_DIR ?? join(homedir(), 'projects', 'Video_Image_Voice', 'models')
}

/**
 * Extract the worker's result line. Library logging (HF Hub, onnxruntime) can
 * write to stdout, so the worker prefixes its result and we search for it rather
 * than parsing the whole stream.
 * @param {string} stdout
 */
export function parseWorkerOutput(stdout) {
  const marker = 'MEDIA_READER_RESULT '
  const lines = String(stdout).split('\n')
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const at = lines[index].indexOf(marker)
    if (at >= 0) return JSON.parse(lines[index].slice(at + marker.length).trim())
  }
  const last = lines.map((line) => line.trim()).filter(Boolean).at(-1)
  if (last === undefined) throw new Error('worker produced no output')
  return JSON.parse(last)
}

function workerFailure(stderr, exitCode) {
  const text = stderr.trim()
  const lines = text.split('\n').filter(Boolean)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim()
    if (!line.startsWith('{')) continue
    try {
      const parsed = JSON.parse(line)
      if (parsed?.code === 'STT_DEPENDENCY_MISSING') {
        return new MediaError('STT_DEPENDENCY_MISSING', `local speech-to-text is not installed: ${parsed.error}`)
      }
      if (typeof parsed?.error === 'string') {
        return new MediaError('STT_FAILED', `speech-to-text failed: ${parsed.error}`)
      }
    } catch {
      // keep looking: the worker may have written a diagnostic after a log line
    }
  }
  return new MediaError(
    'STT_FAILED',
    `speech-to-text worker exited with code ${exitCode}${text.length > 0 ? `: ${text.slice(-400)}` : ''}`
  )
}

/**
 * Transcribe an audio track (or an audio file) to text + timestamps.
 * @param {object} ctx plugin context
 * @param {object} config plugin settings
 * @param {{processPath: string, displayPath: string}} resolved resolved media target
 * @param {{durationSeconds?: number, language?: string, model?: string, maxSeconds?: number, signal?: AbortSignal, skipLock?: boolean}} [options]
 */
export async function transcribeMedia(ctx, config, resolved, options = {}) {
  if (options.skipLock === true) return transcribeOnce(ctx, config, resolved, options)
  return withMediaLock(() => transcribeOnce(ctx, config, resolved, options))
}

async function transcribeOnce(ctx, config, resolved, options = {}) {
  // A caller may supply its own process runner (the evidence pack runs without a
  // DSH server); otherwise use the harness subprocess seam.
  const run = options.runImpl ?? ((argv, runOptions) => runProcess(ctx, argv, runOptions))
  const model = options.model ?? config.sttModel
  // `fullDuration` is the evidence-pack path: a silent 300 s cap on a 368 s
  // source would truncate the analysis without saying so.
  const fullDuration = options.fullDuration === true
  const maxSeconds = fullDuration
    ? Number.POSITIVE_INFINITY
    : Math.min(options.maxSeconds ?? config.maxAudioSeconds, config.maxAudioSeconds)
  const python = config.sttPython ?? defaultSttPython()
  const worker = config.sttWorker ?? DEFAULT_WORKER
  const cacheDir = config.sttModelDir ?? defaultModelDir()

  const dir = await ensureArtifactDir(config.artifactsDir, 'transcripts', resolved.displayPath.split('/').pop() ?? 'audio')
  const wavPath = join(dir, 'audio.wav')
  const started = Date.now()
  try {
    try {
      const decodeArgs = [
        'ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
        '-i', resolved.processPath,
        '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le'
      ]
      if (Number.isFinite(maxSeconds)) decodeArgs.push('-t', String(maxSeconds))
      decodeArgs.push(wavPath)
      await run(
        decodeArgs,
        {
          timeoutMs: config.ffmpegTimeoutMs,
          signal: options.signal,
          maxOutputBytes: 512 * 1024
        }
      )
    } catch (error) {
      if (error instanceof MediaError && error.code === 'SPAWN_FAILED') {
        throw new MediaError('FFMPEG_MISSING', 'ffmpeg is not available on PATH; install it before transcribing audio')
      }
      throw error
    }

    let workerResult
    try {
      workerResult = await run(
        [
          python, worker,
          '--audio', wavPath,
          '--model', model,
          '--compute-type', config.sttComputeType,
          '--threads', String(config.sttThreads),
          '--language', options.language ?? 'auto',
          '--beam-size', String(config.sttBeamSize),
          '--cache-dir', cacheDir
        ],
        {
          timeoutMs: config.sttTimeoutMs,
          signal: options.signal,
          maxOutputBytes: 8 * 1024 * 1024
        }
      )
    } catch (error) {
      if (error instanceof MediaError && error.code === 'SPAWN_FAILED') {
        throw new MediaError(
          'STT_DEPENDENCY_MISSING',
          `the local speech-to-text interpreter is missing: ${python}. Create the project venv and install faster-whisper.`
        )
      }
      throw error
    }

    if (workerResult.exitCode !== 0) throw workerFailure(workerResult.stderr, workerResult.exitCode)
    let payload
    try {
      payload = parseWorkerOutput(workerResult.stdout)
    } catch {
      throw new MediaError('STT_INVALID_OUTPUT', 'speech-to-text worker returned no usable JSON')
    }
    if (payload.ok !== true || !Array.isArray(payload.segments)) {
      throw new MediaError('STT_FAILED', `speech-to-text worker failed: ${payload.error ?? 'unknown error'}`)
    }

    const transcript = {
      model: payload.model ?? model,
      computeType: payload.computeType ?? config.sttComputeType,
      language: payload.language ?? 'unknown',
      languageProbability: payload.languageProbability ?? null,
      duration: Number.isFinite(payload.duration) ? payload.duration : options.durationSeconds ?? maxSeconds,
      text: typeof payload.text === 'string' ? payload.text : '',
      segments: payload.segments.map((segment) => ({
        start: Number(segment.start) || 0,
        end: Number(segment.end) || 0,
        text: String(segment.text ?? '').trim(),
        // Confidence survives the bridge: without it a sung vocal reads exactly
        // like a clean speech transcript downstream.
        ...(Number.isFinite(segment.avgLogprob) ? { avgLogprob: Number(segment.avgLogprob) } : {}),
        ...(Number.isFinite(segment.noSpeechProb) ? { noSpeechProb: Number(segment.noSpeechProb) } : {})
      })).filter((segment) => segment.text.length > 0)
    }
    const artifacts = await writeTranscriptArtifacts(dir, transcript)
    const elapsedMs = Date.now() - started
    const audioSeconds = transcript.duration > 0 ? transcript.duration : maxSeconds
    return {
      ...transcript,
      artifacts,
      elapsedMs,
      realTimeFactor: Math.round((elapsedMs / 1000 / audioSeconds) * 100) / 100,
      truncated: Number.isFinite(maxSeconds) && (options.durationSeconds ?? 0) > maxSeconds
    }
  } finally {
    await rm(wavPath, { force: true }).catch(() => {})
  }
}
