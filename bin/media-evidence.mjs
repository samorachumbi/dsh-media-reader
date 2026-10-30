#!/usr/bin/env node
/**
 * Build a replication evidence pack from one media file.
 *
 * This is the testable half of the media pipeline: it needs no DSH server, makes
 * no network call and no generation request. Everything it prints is measured
 * from the file.
 *
 *   node bin/media-evidence.mjs source.mp4 --mode replica --profile local
 *   node bin/media-evidence.mjs song.mp3 --lyrics --stt-model small
 *   node bin/media-evidence.mjs clip.mp4 --no-lyrics --max-shots 8 --json
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildEvidencePack, jobNameFor } from '../lib/evidence/index.js'
import { createNodeRunner } from '../lib/evidence/runner.js'

const USAGE = `usage: media-evidence <file> [options]

  --out <dir>            root directory for job artifacts (default: ./replication)
  --job <name>           job directory name (default: <slug>-<timestamp>)
  --mode <m>             replica | transform            (default: replica)
  --profile <p>          local | assisted | cloud       (default: local)
  --stt-model <m>        faster-whisper model           (default: base)
  --python <path>        interpreter with faster-whisper (default: .venv-stt/bin/python)
  --max-shots <n>        shot-sheet budget              (default: 30)
  --max-seconds <s>      analysis window (default: the whole file)
  --no-lyrics            skip transcription
  --no-reference-audio   do not keep a lossless audio copy
  --json                 print the machine-readable summary only
  --help                 show this text
`

function parseArgs(argv) {
  const options = { mode: 'replica', profile: 'local', sttModel: 'base', maxShots: 30, lyrics: true, referenceAudio: true, json: false }
  const rest = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`)
      index += 1
      return value
    }
    switch (arg) {
      case '--help': case '-h': options.help = true; break
      case '--out': options.outDir = next(); break
      case '--job': options.job = next(); break
      case '--mode': options.mode = next(); break
      case '--profile': options.profile = next(); break
      case '--stt-model': options.sttModel = next(); break
      case '--python': options.python = next(); break
      case '--max-shots': options.maxShots = Number(next()); break
      case '--max-seconds': options.maxAudioSeconds = Number(next()); break
      case '--no-lyrics': options.lyrics = false; break
      case '--no-reference-audio': options.referenceAudio = false; break
      case '--json': options.json = true; break
      default:
        if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`)
        rest.push(arg)
    }
  }
  if (rest.length !== 1) throw new Error('exactly one media file is required')
  options.filePath = rest[0]
  if (!Number.isFinite(options.maxShots) || options.maxShots < 1) throw new Error('--max-shots must be a positive number')
  return options
}

function line(text) {
  process.stderr.write(`${text}\n`)
}

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    line(`media-evidence: ${error.message}\n`)
    process.stdout.write(USAGE)
    return 2
  }
  if (options.help === true) {
    process.stdout.write(USAGE)
    return 0
  }
  const filePath = resolve(options.filePath)
  if (!existsSync(filePath)) {
    line(`media-evidence: no such file: ${filePath}`)
    return 2
  }

  const run = createNodeRunner()
  const started = Date.now()
  const progress = options.json
    ? () => {}
    : (stage, detail) => line(`  · ${stage}${detail === undefined ? '' : ` — ${detail}`}`)

  let result
  try {
    result = await buildEvidencePack({
      run,
      filePath,
      mode: options.mode,
      profile: options.profile,
      outDir: options.outDir,
      job: options.job ?? jobNameFor(filePath),
      python: options.python,
      sttModel: options.sttModel,
      maxShots: options.maxShots,
      maxAudioSeconds: options.maxAudioSeconds,
      lyrics: options.lyrics,
      keepReferenceAudio: options.referenceAudio,
      onProgress: progress
    })
  } catch (error) {
    line(`media-evidence: FAILED — ${error.message}`)
    return 1
  }

  const pack = result.pack
  const summary = {
    ok: true,
    job: result.job,
    jobDir: result.jobDir,
    mode: pack.mode,
    profile: pack.profile,
    durationSeconds: pack.source.durationSeconds,
    sha256: pack.source.sha256,
    tempo: pack.music?.tempo ?? null,
    key: pack.music?.key ?? null,
    cadence: pack.music?.cadence?.value ?? null,
    sections: Array.isArray(pack.music?.sections?.value) ? pack.music.sections.value.length : 0,
    shots: pack.video?.shotCount?.value ?? null,
    lyrics: pack.lyrics?.value === null || pack.lyrics?.value === undefined
      ? { verdict: 'none' }
      : { verdict: pack.lyrics.value.summary.verdict, words: pack.lyrics.value.summary.words, evidence: pack.lyrics.evidence },
    skipped: pack.skipped.map((entry) => entry.stage),
    timings: result.timings,
    wallMs: Date.now() - started,
    paths: result.paths
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
    return 0
  }

  const tag = (tagged) => (tagged === null || tagged === undefined ? 'n/a' : `${tagged.value} [${tagged.evidence}]`)
  line('')
  line(`job          ${result.job}`)
  line(`source       ${pack.source.durationSeconds}s  ${pack.source.sha256?.slice(0, 16)}…`)
  line(`tempo        ${tag(pack.music?.tempo)}`)
  line(`key          ${tag(pack.music?.key)}`)
  line(`cadence      ${pack.music?.cadence?.value === null ? 'n/a' : `IOI ${pack.music.cadence.value.ioiMedianSec}s, ${pack.music.cadence.value.beatAlternationRatio === undefined ? '' : `alternation ${pack.music.cadence.value.beatAlternationRatio}`} [${pack.music.cadence.evidence}]`}`)
  line(`sections     ${summary.sections}`)
  line(`shots        ${summary.shots === null ? 'n/a' : `${summary.shots.sampled}/${summary.shots.detected} sampled`}`)
  line(`lyrics       ${summary.lyrics.verdict}${summary.lyrics.words === undefined ? '' : ` (${summary.lyrics.words} words, ${summary.lyrics.evidence})`}`)
  line(`stages       ${Object.entries(result.timings).filter(([, ms]) => ms > 0).map(([stage, ms]) => `${stage} ${ms}ms`).join(' · ')}`)
  line(`wall         ${summary.wallMs}ms`)
  line('')
  line(`written      ${result.paths.replicationMd}`)
  line(`             ${result.paths.replicationJson}`)
  line(`             ${result.paths.planJson}`)
  return 0
}

process.exitCode = await main()
