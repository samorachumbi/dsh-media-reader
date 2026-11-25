/**
 * Lyrics for the evidence pack: full-duration transcription with an explicit
 * confidence verdict.
 *
 * The honest problem this file exists for: Whisper is a speech recogniser. On a
 * sung rap vocal it emits fluent-looking text whose per-segment log-probabilities
 * are far worse than on speech, and a pack that prints that text without the
 * numbers invites a generator to "replicate" a lyric that was never sung. So the
 * transcript is kept, the confidence is measured from Whisper's own scores, and
 * the classification (speech-like vs sung-or-uncertain) is a separate field.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeTranscriptArtifacts } from '../artifacts.js'
import { transcribeMedia } from '../stt.js'

/**
 * Summarise per-segment confidence.
 * @param {{start: number, end: number, text: string, avgLogprob?: number, noSpeechProb?: number}[]} segments
 */
export function summariseConfidence(segments) {
  const usable = segments.filter((segment) => Number.isFinite(segment.avgLogprob))
  if (segments.length === 0) {
    return {
      segments: 0,
      words: 0,
      meanAvgLogprob: null,
      meanNoSpeechProb: null,
      lowConfidenceShare: null,
      verdict: 'unverified',
      note: 'no speech-like segments were detected, so there is no transcript to grade'
    }
  }
  const words = segments.reduce((total, segment) => total + segment.text.split(/\s+/u).filter(Boolean).length, 0)
  const meanLogprob = usable.length === 0
    ? null
    : round(usable.reduce((total, segment) => total + segment.avgLogprob, 0) / usable.length, 4)
  const speech = segments.filter((segment) => Number.isFinite(segment.noSpeechProb))
  const meanNoSpeech = speech.length === 0
    ? null
    : round(speech.reduce((total, segment) => total + segment.noSpeechProb, 0) / speech.length, 4)
  const lowConfidence = usable.filter((segment) => segment.avgLogprob < -0.8).length
  const lowShare = usable.length === 0 ? null : round(lowConfidence / usable.length, 3)
  const verdict = meanLogprob === null
    ? 'unverified'
    : meanLogprob >= -0.55 && (meanNoSpeech ?? 0) < 0.45
      ? 'speech-like'
      : 'sung-or-uncertain'
  return {
    segments: segments.length,
    words,
    meanAvgLogprob: meanLogprob,
    meanNoSpeechProb: meanNoSpeech,
    lowConfidenceShare: lowShare,
    verdict,
    note: verdict === 'speech-like'
      ? 'confidence measured from Whisper per-segment log-probabilities'
      : 'Whisper is a speech recogniser: treat this text as an approximation of the vocal, not as the lyric'
  }
}

/**
 * Transcribe the whole audio track and write lyrics artifacts.
 * @param {object} options
 */
export async function readLyrics(options) {
  const started = Date.now()
  const dir = join(options.dir, 'lyrics')
  // stt.js writes its intermediate WAV and transcript files into an artifact
  // directory of its own; point that at a scratch directory, because `lyrics/`
  // is this job's artifact contract and a second transcript tree beside it would
  // be two artifacts with one meaning.
  const scratch = await mkdtemp(join(tmpdir(), 'media-evidence-lyrics-'))
  const config = {
    sttModel: options.model,
    sttComputeType: 'int8',
    sttThreads: options.threads ?? 4,
    sttBeamSize: 1,
    sttPython: options.python,
    sttWorker: options.worker,
    sttModelDir: options.modelDir,
    maxAudioSeconds: Number.POSITIVE_INFINITY,
    sttTimeoutMs: options.timeoutMs ?? 1_800_000,
    ffmpegTimeoutMs: 300_000,
    artifactsDir: scratch
  }
  let transcript
  try {
    transcript = await transcribeMedia(
    undefined,
    config,
    { processPath: options.filePath, displayPath: options.displayPath ?? options.filePath },
    {
      fullDuration: true,
      durationSeconds: options.durationSeconds,
      language: options.language ?? 'auto',
      runImpl: options.run,
      skipLock: true,
      signal: options.signal
    }
    )
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {})
  }
  const confidence = summariseConfidence(transcript.segments)
  const artifacts = await writeTranscriptArtifacts(dir, transcript)
  return {
    transcript,
    confidence,
    artifacts: {
      dir,
      ...artifacts,
      lyricsJson: join(dir, 'lyrics.json')
    },
    elapsedMs: Date.now() - started
  }
}

function round(value, digits) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}
