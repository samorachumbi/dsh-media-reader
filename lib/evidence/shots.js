/**
 * Shot replication sheet.
 *
 * What can be measured about a shot without a semantic model: where it starts and
 * ends, real frames from its beginning, middle and end, and the colour/brightness
 * statistics of those frames. What cannot: the camera move, the action, the
 * lighting design, the transition type, any on-screen text. Those fields are
 * emitted with an UNVERIFIED tag and the reason, so stage 2 (a native video
 * model) or the operator fills them in — the pack never guesses.
 */
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { parseScdetOutput } from '../video.js'

/** Cut times from ffmpeg's scene-change detector. */
export async function detectCuts(run, filePath, { threshold = 10, timeoutMs = 300_000, signal } = {}) {
  const result = await run(
    [
      'ffmpeg', '-hide_banner', '-v', 'info',
      '-i', filePath,
      '-vf', `scdet=threshold=${threshold},metadata=print`,
      '-an', '-f', 'null', '-'
    ],
    { timeoutMs, signal, maxOutputBytes: 16 * 1024 * 1024 }
  )
  if (result.exitCode !== 0) {
    throw new Error(`ffmpeg scene detection failed: ${result.stderr.trim().slice(-400)}`)
  }
  return parseScdetOutput(result.stderr)
}

/**
 * Turn cut times into shot ranges with three sample points each.
 * @param {{timeSec: number, score: number}[]} cuts
 * @param {number} duration
 * @param {number} maxShots
 */
export function planShotRanges(cuts, duration, maxShots) {
  const total = Number.isFinite(duration) && duration > 0 ? duration : 0
  if (total <= 0) return { shots: [], detected: 0, truncated: false }
  const boundaries = [0, ...cuts
    .map((cut) => Number(cut.timeSec))
    .filter((time) => Number.isFinite(time) && time > 0.1 && time < total - 0.1)
    .sort((a, b) => a - b), total]
  const unique = boundaries.filter((value, index) => index === 0 || value - boundaries[index - 1] > 0.1)
  if (unique.at(-1) !== total) unique.push(total)
  const detected = Math.max(1, unique.length - 1)
  const cap = Math.max(1, Math.floor(maxShots))
  const ranges = unique.slice(0, -1).map((start, index) => ({ start, end: unique[index + 1] }))
  const chosen = ranges.length <= cap
    ? ranges.map((range, detectedIndex) => ({ ...range, detectedIndex }))
    : Array.from({ length: cap }, (_, index) => {
        const detectedIndex = Math.round((index * (ranges.length - 1)) / (cap - 1))
        return { ...ranges[detectedIndex], detectedIndex }
      })
  const inventory = ranges.map((range, index) => ({
    detectedShot: index + 1,
    startSec: round(range.start, 3),
    endSec: round(range.end, 3),
    durationSec: round(Math.max(0, range.end - range.start), 3)
  }))
  const shots = chosen.map((range, index) => {
    const span = Math.max(0.05, range.end - range.start)
    const margin = Math.min(0.15, span / 4)
    return {
      index: index + 1,
      // The sampled order and the detected order are different numbers once the
      // budget kicks in; keeping both makes a row traceable back to the source.
      detectedShot: range.detectedIndex + 1,
      startSec: round(range.start, 3),
      endSec: round(range.end, 3),
      durationSec: round(span, 3),
      frames: [
        { role: 'start', atSec: round(range.start + margin, 3) },
        { role: 'mid', atSec: round(range.start + span / 2, 3) },
        { role: 'end', atSec: round(range.end - margin, 3) }
      ]
    }
  })
  return { shots, boundaries: inventory, detected, truncated: ranges.length > cap }
}

/**
 * Pick continuous segments a video model can actually accept.
 *
 * Kling Omni Transformation requires 3-15.5 s and Wan Animate Replace takes a
 * short clip, so a 1-second cut is useless for a pilot. This chooses the longest
 * continuous shots first and reports honestly when nothing long enough exists,
 * instead of quietly handing over a 1.2 s clip.
 */
export function selectPilotShots(boundaries, options = {}) {
  const minSeconds = options.minSeconds ?? 3
  const maxSeconds = options.maxSeconds ?? 8
  const count = options.count ?? 3
  const margin = options.margin ?? 0.15
  const usable = (boundaries ?? [])
    .filter((shot) => Number.isFinite(shot.startSec) && Number.isFinite(shot.endSec) && shot.endSec > shot.startSec)
  const longEnough = usable.filter((shot) => shot.endSec - shot.startSec >= minSeconds)
  // A sub-3s clip cannot be sent to an endpoint that requires 3-15.5s, so it is
  // not a pilot. Return none and say why rather than offering something unusable.
  if (longEnough.length === 0) {
    return {
      pilots: [],
      candidatesInRange: 0,
      totalShots: usable.length,
      note: `no continuous shot reached ${minSeconds}s (longest ${round(Math.max(0, ...usable.map((shot) => shot.endSec - shot.startSec)), 3)}s); ` +
        'use a still frame with image-to-video, or regenerate from the full shot list instead'
    }
  }
  const selected = longEnough
    .slice()
    .sort((a, b) => (b.endSec - b.startSec) - (a.endSec - a.startSec))
    .slice(0, Math.max(1, count))
    .sort((a, b) => a.startSec - b.startSec)
    .map((shot) => {
      const duration = shot.endSec - shot.startSec
      const useWhole = duration <= maxSeconds
      const startSec = useWhole ? shot.startSec + Math.min(margin, duration / 4) : shot.startSec
      const endSec = useWhole
        ? shot.endSec - Math.min(margin, duration / 4)
        : Math.min(shot.endSec, startSec + maxSeconds)
      return {
        detectedShot: shot.detectedShot,
        sourceStartSec: shot.startSec,
        sourceEndSec: shot.endSec,
        startSec: round(startSec, 3),
        endSec: round(endSec, 3),
        durationSec: round(Math.max(0, endSec - startSec), 3),
        wholeShot: useWhole
      }
    })
    .filter((shot) => shot.durationSec >= 1)
  return {
    pilots: selected,
    candidatesInRange: longEnough.length,
    totalShots: usable.length,
    note: selected.length === 0 ? 'no shot could be cut into a usable pilot clip' : undefined
  }
}

/** Extract one PNG frame at a timestamp, scaled down to a sane reference width. */
async function extractFrame(run, filePath, atSec, outPath, { maxWidth = 960, timeoutMs = 120_000, signal } = {}) {
  const result = await run(
    [
      'ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
      '-ss', atSec.toFixed(3), '-i', filePath,
      '-frames:v', '1',
      '-vf', `scale='min(${maxWidth},iw)':-2`,
      outPath
    ],
    { timeoutMs, signal, maxOutputBytes: 256 * 1024 }
  )
  if (result.exitCode !== 0) {
    throw new Error(`ffmpeg could not extract a frame at ${atSec}s: ${result.stderr.trim().slice(-200)}`)
  }
  return outPath
}

/**
 * Colour and brightness statistics from real pixels.
 * @param {Buffer} rgb raw RGB24 bytes of a tiny scaled frame
 */
export function summarisePixels(rgb) {
  const pixels = Math.floor(rgb.length / 3)
  if (pixels === 0) return null
  let r = 0
  let g = 0
  let b = 0
  let luma = 0
  let saturation = 0
  const buckets = new Map()
  for (let index = 0; index < pixels; index += 1) {
    const red = rgb[index * 3]
    const green = rgb[index * 3 + 1]
    const blue = rgb[index * 3 + 2]
    r += red
    g += green
    b += blue
    const y = 0.2126 * red + 0.7152 * green + 0.0722 * blue
    luma += y
    const max = Math.max(red, green, blue)
    const min = Math.min(red, green, blue)
    saturation += max === 0 ? 0 : (max - min) / max
    const key = `${red >> 5}-${green >> 5}-${blue >> 5}`
    const entry = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0 }
    entry.count += 1
    entry.r += red
    entry.g += green
    entry.b += blue
    buckets.set(key, entry)
  }
  const dominant = [...buckets.values()]
    .sort((a, b2) => b2.count - a.count)
    .slice(0, 3)
    .map((entry) => ({
      hex: toHex(entry.r / entry.count, entry.g / entry.count, entry.b / entry.count),
      share: round(entry.count / pixels, 3)
    }))
  return {
    meanRgb: [Math.round(r / pixels), Math.round(g / pixels), Math.round(b / pixels)],
    meanLuma: round(luma / pixels, 1),
    meanSaturation: round(saturation / pixels, 3),
    dominant
  }
}

function toHex(r, g, b) {
  return `#${[r, g, b].map((value) => Math.max(0, Math.min(255, Math.round(value)))
    .toString(16).padStart(2, '0')).join('')}`
}

/** Decode one frame to 16x16 RGB and summarise it. */
async function measureFrame(run, filePath, atSec, { timeoutMs = 120_000, signal } = {}) {
  const raw = `/tmp/media-evidence-${process.pid}-${Math.round(atSec * 1000)}.rgb`
  try {
    const result = await run(
      [
        'ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
        '-ss', atSec.toFixed(3), '-i', filePath,
        '-frames:v', '1', '-vf', 'scale=16:16', '-pix_fmt', 'rgb24',
        '-f', 'rawvideo', raw
      ],
      { timeoutMs, signal, maxOutputBytes: 256 * 1024 }
    )
    if (result.exitCode !== 0) return null
    return summarisePixels(await readFile(raw))
  } finally {
    await rm(raw, { force: true }).catch(() => {})
  }
}

/**
 * Build the whole shot sheet: frames on disk plus measured statistics.
 * @returns {Promise<{shots: object[], detected: number, truncated: boolean, wallMs: number}>}
 */
export async function buildShotSheet(run, options) {
  const started = Date.now()
  const timeoutMs = options.timeoutMs ?? 120_000
  const signal = options.signal
  const frameDir = join(options.dir, 'frames')
  const cuts = await detectCuts(run, options.filePath, {
    threshold: options.sceneThreshold ?? 10,
    timeoutMs: Math.max(timeoutMs, 300_000),
    signal
  })
  const planned = planShotRanges(cuts, options.durationSeconds, options.maxShots ?? 30)
  const shots = []
  for (const shot of planned.shots) {
    const entry = { ...shot, files: {}, palette: {} }
    for (const frame of shot.frames) {
      const name = `shot-${String(shot.index).padStart(3, '0')}-${frame.role}.png`
      const path = join(frameDir, name)
      try {
        await extractFrame(run, options.filePath, frame.atSec, path, { timeoutMs, signal, maxWidth: options.maxWidth ?? 960 })
        entry.files[frame.role] = path
        // Only the middle frame gets a palette measurement: it is the frame the
        // pack reports, and measuring all three tripled the ffmpeg spawns for
        // data nothing read.
        if (frame.role === 'mid') {
          entry.palette[frame.role] = await measureFrame(run, options.filePath, frame.atSec, { timeoutMs, signal })
        }
      } catch (error) {
        entry.files[frame.role] = null
        entry.palette[frame.role] = null
        entry.frameError = error.message
      }
    }
    shots.push(entry)
  }
  return {
    shots,
    boundaries: planned.boundaries ?? [],
    pilots: selectPilotShots(planned.boundaries ?? [], {
      minSeconds: options.pilotMinSeconds ?? 3,
      maxSeconds: options.pilotMaxSeconds ?? 8,
      count: options.pilotCount ?? 3
    }),
    detected: planned.detected,
    truncated: planned.truncated,
    cuts: cuts.length,
    wallMs: Date.now() - started
  }
}

function round(value, digits) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}
