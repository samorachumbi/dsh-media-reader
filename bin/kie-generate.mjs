#!/usr/bin/env node
/**
 * Plan or execute one Kie generation task.
 *
 * Planning is free, needs no credential and is the default. A paid task requires
 * all three: --execute, --enable-generation and --max-credits. There is no batch
 * mode, so every submitted task is an explicit operator action.
 *
 *   node bin/kie-generate.mjs cover --audio cue.mp3 --duration 60 --max-credits 5
 *   node bin/kie-generate.mjs animate-replace --video clip.mp4 --image ref.png \
 *     --max-credits 5 --execute --enable-generation
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { maskKey, resolveKieKey } from '../lib/kie/client.js'
import {
  executeGeneration,
  normaliseWorkflowName,
  planGeneration
} from '../lib/kie/generation.js'

const USAGE = `usage: kie-generate <workflow> [options]

workflows:
  music-generate     Generate Music from text (no source upload)
  cover              Upload And Cover: re-style a 10-360 s source while keeping melody
  reference-video    Kling 4.0 Reference To Video (prompt-only text-to-video is allowed)
  animate-replace    Wan 2.2 Animate Replace (source video + character image)

common options:
  --mode <m>             replica | transform                   (default: replica)
  --change <text>        required for transform; describe the intended change
  --max-credits <n>      hard per-task cap; always required, before and after the call
  --pilot-budget <n>     cumulative cap across result files under --out; required and >= task cap
  --out <dir>            root for generations                  (default: ./generation)
  --job <name>           job directory name
  --source-seconds <n>   source duration for the cover 480 s preflight
  --kie-env <file>       file holding KIE_AI_API_KEY           (default: ~/projects/Website_Builder/.env)
  --task-timeout <ms>    polling deadline                       (default: 900000)
  --interval-ms <ms>     initial polling interval               (default: 5000)
  --enable-generation    second explicit switch; does not execute by itself
  --execute              make the paid call (requires --enable-generation + cap)
  --json                 print machine-readable output
  --help                 show this text

cover options:
  --audio <file>         one source audio file                  (required)
  --duration <seconds>   target duration, 10-360                (required)
  --suno-model <m>       V6 | V6_MINI | V6_WILD                  (default: V6)
  --instrumental         no vocals; forbids lyrics/prompt/vocal gender
  --style <text>         style guidance
  --title <text>         output title, max 80 chars
  --lyrics <text>        lyrics, max 5000 chars
  --lyrics-file <file>   read lyrics from a file
  --prompt <text>        prompt used as lyrics when --lyrics is absent
  --negative-tags <text> styles to avoid
  --vocal-gender <m|f>
  --style-weight <0-1>   --weirdness <0-1>   --audio-weight <0-1>
  --variety <0-4>

music-generate options:
  --title <text>         required track title, max 80 chars
  --duration <seconds>   target duration, 10-360                (required)
  --suno-model <m>       V6 | V6_MINI | V6_WILD                  (default: V6)
  --style <text>         music style, max 1000 chars
  --lyrics <text>        lyrics, max 5000 chars
  --lyrics-file <file>   read lyrics from a file
  --negative-tags <text> styles to avoid
  --vocal-gender <m|f>   --instrumental
  --style-weight <0-1>   --weirdness <0-1>   --audio-weight <0-1>
  --variety <0-4>

reference-video options:
  --video <file>         reference clip; repeat up to 5
  --image <file>         reference image; repeat up to 10
  --prompt <text>        required; mention materials as @video_1, @image_1, ...
  --prompt-file <file>   read prompt from a file
  --duration <seconds>   output duration, 3-30                  (default: 5)
  --resolution <r>       720p | 1080p                           (default: 720p)
  --aspect-ratio <r>     auto | 16:9 | 9:16 | 1:1 | 21:9
  --keep-original-sound  keep audio from the reference video

animate-replace options:
  --video <file>         exactly one source video, max 10 MB
  --image <file>         exactly one character image, max 10 MB
  --resolution <r>       480p | 580p | 720p                     (default: 720p)
`

function parseArgs(argv) {
  const options = {
    mode: 'replica',
    assets: [],
    params: {},
    enabled: false,
    execute: false,
    json: false
  }
  const rest = []
  const take = (index, flag) => {
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`)
    return value
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const value = () => {
      const next = take(index, arg)
      index += 1
      return next
    }
    switch (arg) {
      case '--help': case '-h': options.help = true; break
      case '--mode': options.mode = value(); break
      case '--change': options.change = value(); break
      case '--max-credits': options.maxCredits = Number(value()); break
      case '--pilot-budget': options.pilotBudget = Number(value()); break
      case '--out': options.outDir = value(); break
      case '--job': options.job = value(); break
      case '--source-seconds': options.sourceDurationSeconds = Number(value()); break
      case '--kie-env': options.kieEnv = value(); break
      case '--task-timeout': options.taskTimeoutMs = Number(value()); break
      case '--interval-ms': options.intervalMs = Number(value()); break
      case '--enable-generation': options.enabled = true; break
      case '--execute': options.execute = true; break
      case '--json': options.json = true; break
      case '--audio': options.assets.push({ role: 'audio', path: value() }); break
      case '--video': options.assets.push({ role: 'video', path: value() }); break
      case '--image': options.assets.push({ role: 'image', path: value() }); break
      case '--duration': options.params.duration = Number(value()); break
      case '--suno-model': options.params.sunoModel = value(); break
      case '--instrumental': options.params.instrumental = true; break
      case '--style': options.params.style = value(); break
      case '--title': options.params.title = value(); break
      case '--lyrics': options.params.lyrics = value(); break
      case '--lyrics-file': options.lyricsFile = value(); break
      case '--prompt': options.params.prompt = value(); break
      case '--prompt-file': options.promptFile = value(); break
      case '--negative-tags': options.params.negativeTags = value(); break
      case '--vocal-gender': options.params.vocalGender = value(); break
      case '--style-weight': options.params.styleWeight = Number(value()); break
      case '--weirdness': options.params.weirdnessConstraint = Number(value()); break
      case '--audio-weight': options.params.audioWeight = Number(value()); break
      case '--variety': options.params.variety = Number(value()); break
      case '--resolution': options.params.resolution = value(); break
      case '--aspect-ratio': options.params.aspectRatio = value(); break
      case '--keep-original-sound': options.params.keepOriginalSound = true; break
      default:
        if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`)
        rest.push(arg)
    }
  }
  if (options.help === true) return options
  if (rest.length !== 1) throw new Error('exactly one workflow is required')
  options.workflow = rest[0]
  if (!Number.isFinite(options.maxCredits)) throw new Error('--max-credits is required and must be a number')
  if (options.maxCredits <= 0) throw new Error('--max-credits must be greater than zero')
  if (!Number.isFinite(options.pilotBudget)) throw new Error('--pilot-budget is required and must be a number')
  if (options.pilotBudget <= 0) throw new Error('--pilot-budget must be greater than zero')
  if (options.pilotBudget < options.maxCredits) {
    throw new Error('--pilot-budget must be at least --max-credits so one task fits within the pilot budget')
  }
  if (options.taskTimeoutMs !== undefined && (!Number.isFinite(options.taskTimeoutMs) || options.taskTimeoutMs < 1)) {
    throw new Error('--task-timeout must be a positive number')
  }
  if (options.intervalMs !== undefined && (!Number.isFinite(options.intervalMs) || options.intervalMs < 1)) {
    throw new Error('--interval-ms must be a positive number')
  }
  return options
}

function line(text) {
  process.stderr.write(`${text}\n`)
}

async function resolveTextFile(value, field) {
  const path = resolve(value)
  if (!existsSync(path)) throw new Error(`${field} does not exist: ${path}`)
  return readFile(path, 'utf8')
}

async function addTextFiles(options) {
  if (options.lyricsFile !== undefined) {
    if (options.params.lyrics !== undefined) throw new Error('use --lyrics or --lyrics-file, not both')
    options.params.lyrics = (await resolveTextFile(options.lyricsFile, '--lyrics-file')).trim()
  }
  if (options.promptFile !== undefined) {
    if (options.params.prompt !== undefined) throw new Error('use --prompt or --prompt-file, not both')
    options.params.prompt = (await resolveTextFile(options.promptFile, '--prompt-file')).trim()
  }
}

function printDryRun(plan) {
  line('')
  line(`workflow     ${plan.workflow}`)
  line(`model        ${plan.model}`)
  line(`mode         ${plan.mode}${plan.change === null ? '' : ` — ${plan.change}`}`)
  line(`budget cap   ${plan.budget.maxCredits} credits per task · ${plan.budget.totalMaxCredits} credits total pilot envelope`)
  line(`assets       ${plan.assets.length === 0 ? 'none' : plan.assets.map((asset) => `${asset.role} ${(asset.bytes / (1024 * 1024)).toFixed(2)} MB`).join(', ')}`)
  line(`request      ${plan.model} ${JSON.stringify(plan.request.input)}`)
  for (const warning of plan.warnings) line(`warning      ${warning}`)
  line('')
  line('DRY RUN — no credential was read, no upload, no task, no credits spent.')
  line('To execute: add --execute --enable-generation with the approved --max-credits/--pilot-budget.')
}

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
    if (options.help !== true) {
      options.workflow = normaliseWorkflowName(options.workflow)
      await addTextFiles(options)
      if (options.execute && !options.enabled) {
        throw new Error('--execute also requires --enable-generation')
      }
    }
  } catch (error) {
    line(`kie-generate: ${error.message}\n`)
    process.stdout.write(USAGE)
    return 2
  }
  if (options.help === true) {
    process.stdout.write(USAGE)
    return 0
  }

  const common = {
    workflow: options.workflow,
    mode: options.mode,
    change: options.change,
    maxCredits: options.maxCredits,
    totalMaxCredits: options.pilotBudget,
    assets: options.assets,
    params: options.params,
    sourceDurationSeconds: options.sourceDurationSeconds,
    enabled: options.enabled,
    outDir: options.outDir,
    job: options.job,
    taskTimeoutMs: options.taskTimeoutMs,
    intervalMs: options.intervalMs
  }

  if (!options.execute) {
    let plan
    try {
      plan = await planGeneration(common)
    } catch (error) {
      line(`kie-generate: ${error.message}`)
      return 2
    }
    if (options.json) process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
    else printDryRun(plan)
    return 0
  }

  let key
  try {
    const envFile = options.kieEnv ?? resolve(homedir(), 'projects/Website_Builder/.env')
    key = await resolveKieKey({ envFile: existsSync(envFile) ? envFile : undefined })
    line(`  · kie credential ${maskKey(key)}`)
  } catch (error) {
    line(`kie-generate: ${error.message}`)
    return 2
  }

  const progress = options.json
    ? () => {}
    : (event) => line(`  · ${event.stage}${event.detail === undefined ? '' : ` — ${event.detail}`}`)
  try {
    const result = await executeGeneration({ ...common, key, enabled: true }, { })
    const summary = {
      ok: true,
      ...result
    }
    if (options.json) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
    else {
      line('')
      line(`status       ${result.status}`)
      line(`workflow     ${result.workflow}`)
      line(`task         ${result.taskId}`)
      line(`outputs      ${result.outputs.map((output) => output.path).join(', ')}`)
      line(`credits      cap ${result.credits.cap} · spent ${result.credits.spent ?? 'unknown'} · pilot ${result.pilotBudget.totalSpent ?? 'unknown'}/${result.pilotBudget.totalMaxCredits}`)
      line(`written      ${result.resultPath}`)
      line(`             ${result.plan}`)
    }
    return 0
  } catch (error) {
    line(`kie-generate: FAILED — ${error.message}`)
    if (error.result?.resultPath !== undefined) {
      line(`  archived output: ${error.result.outputs.map((output) => output.path).join(', ')}`)
      line(`  result manifest: ${error.result.resultPath}`)
    }
    return 1
  }
}

process.exitCode = await main()
