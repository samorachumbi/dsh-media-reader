/**
 * The assisted semantic pass: ask a multimodal model what the measurements cannot
 * establish, and mark every answer as INFERRED.
 *
 * This is the only place in the pack where a model's opinion enters. Three rules
 * keep it honest:
 *
 * 1. It is **conditioned on the measured facts** — the prompt carries tempo, key,
 *    regions, onset rate and the shot table, so the model is explaining evidence
 *    rather than inventing a track from nothing.
 * 2. Every value it returns is tagged INFERRED with the model name and latency,
 *    never MEASURED. A number a model asserts is not a measurement.
 * 3. A non-JSON or empty answer is a **named failure**, not an empty object: the
 *    caller keeps the raw text and reports UNVERIFIED. A silent `{}` would look
 *    exactly like "the model found nothing".
 */
import { appendLedger, getCredits, kieRequest, KieError, uploadFile } from '../kie/client.js'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const SEMANTIC_MODEL = 'gemini-3-pro'
export const SEMANTIC_PATH = '/gemini-3-pro/v1/chat/completions'

/** Parse a model reply that is supposed to be JSON, tolerating a code fence. */
export function parseSemanticJson(text) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new KieError('SEMANTIC_EMPTY', 'the model returned no text')
  }
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/u)
  const candidate = (fenced === null ? text : fenced[1]).trim()
  try {
    return JSON.parse(candidate)
  } catch (error) {
    throw new KieError('SEMANTIC_NOT_JSON', `the model reply was not JSON: ${error.message}`, text.slice(0, 600))
  }
}

/** Coerce one returned field into a list of entries, dropping nothing silently. */
function asArray(value) {
  return Array.isArray(value) ? value.filter((entry) => entry !== null && entry !== undefined) : []
}

function asText(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function asConfidence(value) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : null
}

/**
 * Validate and normalise the model's answer. Unknown shapes are kept as `null`
 * rather than guessed, and every entry carries the confidence it was given.
 */
export function normaliseSemantic(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new KieError('SEMANTIC_SHAPE', 'the model reply was not a JSON object')
  }
  const instruments = asArray(payload.instruments).map((entry) => ({
    name: asText(entry?.name),
    role: asText(entry?.role),
    confidence: asConfidence(entry?.confidence),
    evidence: asText(entry?.evidence)
  })).filter((entry) => entry.name !== null)

  const sections = asArray(payload.sections).map((entry) => ({
    startSec: Number.isFinite(Number(entry?.startSec)) ? Number(entry.startSec) : null,
    endSec: Number.isFinite(Number(entry?.endSec)) ? Number(entry.endSec) : null,
    role: asText(entry?.role),
    confidence: asConfidence(entry?.confidence)
  })).filter((entry) => entry.role !== null && entry.startSec !== null && entry.endSec !== null)

  const chords = asArray(payload.chords).map((entry) => ({
    startSec: Number.isFinite(Number(entry?.startSec)) ? Number(entry.startSec) : null,
    endSec: Number.isFinite(Number(entry?.endSec)) ? Number(entry.endSec) : null,
    chord: asText(entry?.chord),
    confidence: asConfidence(entry?.confidence)
  })).filter((entry) => entry.chord !== null && entry.startSec !== null && entry.endSec !== null)

  const shots = asArray(payload.shots).map((entry) => ({
    // The model is asked to answer per ATTACHED IMAGE, because asking it to guess
    // a detected-shot number it was never shown produced a mapping that silently
    // pointed at the wrong shots.
    mediaItem: Number.isFinite(Number(entry?.mediaItem ?? entry?.mediaItemIndex ?? entry?.index))
      ? Number(entry.mediaItem ?? entry.mediaItemIndex ?? entry.index)
      : null,
    detectedShot: Number.isFinite(Number(entry?.detectedShot)) ? Number(entry.detectedShot) : null,
    action: asText(entry?.action),
    camera: asText(entry?.camera),
    lighting: asText(entry?.lighting),
    transition: asText(entry?.transition),
    onScreenText: asText(entry?.onScreenText),
    confidence: asConfidence(entry?.confidence)
  })).filter((entry) => entry.mediaItem !== null || entry.detectedShot !== null)

  const vocal = payload.vocal === null || typeof payload.vocal !== 'object'
    ? null
    : {
        delivery: asText(payload.vocal.delivery),
        register: asText(payload.vocal.register),
        flowNotes: asText(payload.vocal.flowNotes),
        adlibs: asText(payload.vocal.adlibs),
        effects: asText(payload.vocal.effects),
        confidence: asConfidence(payload.vocal.confidence)
      }

  const mix = payload.mix === null || typeof payload.mix !== 'object'
    ? null
    : { notes: asText(payload.mix.notes), confidence: asConfidence(payload.mix.confidence) }

  return {
    genre: asText(payload.genre),
    vibe: asText(payload.vibe),
    era: asText(payload.era),
    mood: asText(payload.mood),
    instruments,
    vocal,
    sections,
    chords,
    shots,
    mix,
    cautions: asArray(payload.cautions).map((entry) => asText(entry)).filter((entry) => entry !== null)
  }
}

/** Build the prompt: measured facts first, then the questions, then the contract. */
export function buildSemanticPrompt(input) {
  const facts = []
  facts.push(`File: ${input.sourceName}`)
  if (Number.isFinite(input.durationSeconds)) facts.push(`Duration: ${input.durationSeconds.toFixed(2)} s`)
  if (input.tempo !== null && input.tempo !== undefined) {
    facts.push(`Tempo (measured): ${input.tempo.bpm} BPM, confidence ${input.tempo.confidence}` +
      (input.tempo.octaveAlternative ? `, half/double alternative ${input.tempo.octaveAlternative.bpm} BPM` : ''))
  }
  if (input.key !== null && input.key !== undefined) {
    facts.push(`Key (measured): ${input.key.tonic} ${input.key.mode}, correlation ${input.key.correlation}`)
  }
  if (Number.isFinite(input.onsetRate)) facts.push(`Loudness onsets: ${input.onsetRate}/s`)
  if (Number.isFinite(input.loudnessLufs)) facts.push(`Integrated loudness: ${input.loudnessLufs} LUFS`)
  if (Array.isArray(input.sections) && input.sections.length > 0) {
    facts.push('Measured novelty regions: ' + input.sections
      .map((section) => `${section.startSec}-${section.endSec}s (energy ${section.energyDb} dB)`)
      .join('; '))
  }
  if (Array.isArray(input.shots) && input.shots.length > 0) {
    facts.push('Measured shot boundaries: ' + input.shots
      .map((shot) => `#${shot.detectedShot} ${shot.startSec}-${shot.endSec}s`)
      .join('; '))
  }
  const mediaNote = input.mediaCount > 0
    ? `${input.mediaCount} media item(s) are attached:\n` +
      (input.mediaItems ?? []).map((item) => `  - media item ${item.index}: ${item.describe}`).join('\n')
    : 'No media is attached; answer only from the measurements above and say so where you cannot.'

  return [
    'You are analysing one music video so it can be recreated or deliberately transformed by a generative model.',
    '',
    'MEASURED FACTS (these are real measurements; do not contradict them):',
    ...facts.map((fact) => `- ${fact}`),
    '',
    mediaNote,
    '',
    'Answer with a single JSON object and nothing else. Use null for anything you cannot judge. ' +
    'Give a 0-1 confidence on every claim. Do not restate the measured tempo or key as your own finding.',
    '',
    'Schema:',
    '{',
    '  "genre": string|null, "vibe": string|null, "era": string|null, "mood": string|null,',
    '  "instruments": [{"name": string, "role": string|null, "confidence": number, "evidence": string|null}],',
    '  "vocal": {"delivery": string|null, "register": string|null, "flowNotes": string|null, ' +
      '"adlibs": string|null, "effects": string|null, "confidence": number}|null,',
    '  "sections": [{"startSec": number, "endSec": number, "role": string, "confidence": number}],',
    '  "chords": [{"startSec": number, "endSec": number, "chord": string, "confidence": number}],',
    '  "shots": [{"mediaItem": number, "action": string|null, "camera": string|null, ' +
      '"lighting": string|null, "transition": string|null, "onScreenText": string|null, "confidence": number}],',
    '  "mix": {"notes": string|null, "confidence": number}|null,',
    '  "cautions": [string]',
    '}',
    '',
    'For "sections" use structural roles (intro, verse, hook, bridge, outro) but only where the audio or ' +
    'region boundaries support it. For "shots" answer per ATTACHED IMAGE using its "media item" number from ' +
    'the list above — do not invent shot numbers. Put anything you are guessing about into "cautions".'
  ].join('\n')
}

/**
 * Run the semantic pass.
 *
 * @param {object} options
 * @param {string} options.key Kie credential
 * @param {string} options.dir job directory
 * @param {string} options.ledgerPath ledger path
 * @param {object} options.facts measured facts for the prompt
 * @param {string[]} [options.mediaPaths] images (keyframes) to attach
 * @param {string} [options.audioPath] audio to upload and attach
 * @param {number} [options.minCredits]
 * @param {(event: object) => void} [options.onProgress]
 */
export async function runSemanticPass(options) {
  const started = Date.now()
  const progress = options.onProgress ?? (() => {})
  const notesDir = join(options.dir, 'notes')
  await mkdir(notesDir, { recursive: true, mode: 0o700 })

  const creditsBefore = await getCredits(options.key).catch(() => null)
  if (Number.isFinite(options.minCredits) && creditsBefore !== null && creditsBefore < options.minCredits) {
    throw new KieError(
      'KIE_INSUFFICIENT_CREDITS',
      `balance ${creditsBefore} is below the required floor ${options.minCredits}; the semantic pass did not run`
    )
  }

  const media = []
  const mediaItems = []
  const described = []
  if (typeof options.audioPath === 'string' && options.audioPath.length > 0) {
    progress({ stage: 'semantic', detail: 'uploading audio' })
    const uploaded = await uploadFile(options.key, options.audioPath)
    media.push(uploaded.url)
    const audioDescribe = options.audioNote ?? 'the audio track'
    mediaItems.push({ index: media.length, describe: audioDescribe, kind: 'audio' })
    described.push(audioDescribe)
  }
  for (const frame of options.frames ?? []) {
    progress({ stage: 'semantic', detail: `uploading keyframe for shot ${frame.detectedShot}` })
    const uploaded = await uploadFile(options.key, frame.path)
    media.push(uploaded.url)
    const describe = `a keyframe of detected shot ${frame.detectedShot} (${frame.startSec.toFixed(2)}-${frame.endSec.toFixed(2)}s)`
    mediaItems.push({ index: media.length, describe, kind: 'image', detectedShot: frame.detectedShot })
    described.push(describe)
  }

  const prompt = buildSemanticPrompt({
    ...options.facts,
    mediaCount: media.length,
    mediaItems
  })

  progress({ stage: 'semantic', detail: `asking ${SEMANTIC_MODEL} with ${media.length} media item(s)` })
  const requested = Date.now()
  let payload
  try {
    payload = await kieRequest(options.key, SEMANTIC_PATH, {
    method: 'POST',
    timeoutMs: options.timeoutMs ?? 600_000,
    body: {
      stream: false,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            ...media.map((url) => ({ type: 'image_url', image_url: { url } }))
          ]
        }
      ]
    }
    })
  } catch (error) {
    await appendLedger(options.ledgerPath, {
      kind: 'semantic-pass',
      provider: 'kie',
      model: SEMANTIC_MODEL,
      endpoint: SEMANTIC_PATH,
      state: 'FAILED',
      reason: error.message,
      mediaCount: media.length,
      elapsedMs: Date.now() - started
    })
    throw error
  }
  const latencyMs = Date.now() - requested

  const message = payload?.choices?.[0]?.message
  const text = typeof message?.content === 'string'
    ? message.content
    : Array.isArray(message?.content)
      ? message.content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('\n')
      : ''
  await writeFile(join(notesDir, 'semantic-raw.json'), `${JSON.stringify({ prompt, media, payload }, null, 2)}\n`, 'utf8')

  const parsed = parseSemanticJson(text)
  const normalised = normaliseSemantic(parsed)
  // Resolve mediaItem → detectedShot locally. The model never saw a shot number it
  // could verify, so this mapping must come from what was actually attached.
  const byItem = new Map(mediaItems.filter((item) => item.kind === 'image').map((item) => [item.index, item.detectedShot]))
  normalised.shots = normalised.shots
    .map((shot) => ({
      ...shot,
      detectedShot: shot.mediaItem === null ? shot.detectedShot : (byItem.get(shot.mediaItem) ?? null)
    }))
    .filter((shot) => shot.detectedShot !== null)
  const creditsAfter = await getCredits(options.key).catch(() => null)
  const elapsedMs = Date.now() - started
  const row = await appendLedger(options.ledgerPath, {
    kind: 'semantic-pass',
    provider: 'kie',
    model: SEMANTIC_MODEL,
    endpoint: SEMANTIC_PATH,
    mediaCount: media.length,
    mediaNote: described.join(', '),
    latencyMs,
    creditsBefore,
    creditsAfter,
    creditsSpent: creditsBefore === null || creditsAfter === null ? null : creditsBefore - creditsAfter,
    elapsedMs
  })
  await appendFile(join(notesDir, 'semantic.json'), `${JSON.stringify({ ...normalised, model: SEMANTIC_MODEL, latencyMs, ledgerAt: row.at }, null, 2)}\n`, 'utf8')

  return {
    provider: 'kie',
    model: SEMANTIC_MODEL,
    latencyMs,
    mediaCount: media.length,
    mediaNote: described.join(', '),
    mediaItems: mediaItems.map((item) => ({ index: item.index, kind: item.kind, detectedShot: item.detectedShot ?? null })),
    creditsBefore,
    creditsAfter,
    elapsedMs,
    fields: normalised,
    evidence: 'INFERRED',
    note: 'a model\'s interpretation of the measured evidence; never a measurement'
  }
}
