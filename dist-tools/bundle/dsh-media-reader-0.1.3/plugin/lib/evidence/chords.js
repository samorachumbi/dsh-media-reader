/**
 * Chord candidates from the measured chroma series.
 *
 * This is deliberately the most conservative chord reader that still says
 * something useful: major and minor triads only, matched against the chroma the
 * DSP worker already measured, with a confidence that is the margin over the
 * runner-up. It is graded INFERRED rather than MEASURED because a template match
 * is an interpretation of a measurement, not the measurement itself.
 *
 * Known limit, stated rather than hidden: a rap mix with a strong 808 and dense
 * percussion blurs pitch classes, so triads can go undetected rather than being
 * reported wrongly. Segments below the confidence floor are dropped, not guessed.
 */
export const NOTE_NAMES = Object.freeze(['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'])

export const TRIADS = Object.freeze({
  major: [0, 4, 7],
  minor: [0, 3, 7]
})

/** Build the 12-value template for one chord. */
export function chordTemplate(rootIndex, quality) {
  const template = new Array(12).fill(0)
  for (const step of TRIADS[quality]) template[(rootIndex + step) % 12] = 1
  return template
}

/**
 * Score one 12-value chroma vector against every triad.
 * @returns {{label: string, score: number, inChord: number, outOfChord: number}[]} sorted best first
 */
export function scoreChroma(chroma) {
  const total = chroma.reduce((sum, value) => sum + value, 0)
  if (!(total > 0)) return []
  const normalised = chroma.map((value) => value / total)
  const ranked = []
  for (let root = 0; root < 12; root += 1) {
    for (const quality of Object.keys(TRIADS)) {
      const template = chordTemplate(root, quality)
      let inChord = 0
      let outOfChord = 0
      for (let pitch = 0; pitch < 12; pitch += 1) {
        if (template[pitch] === 1) inChord += normalised[pitch]
        else outOfChord += normalised[pitch]
      }
      // A triad that owns the energy wins; energy outside the triad is penalised
      // because a chromatic mess should not read as a confident chord.
      ranked.push({
        label: `${NOTE_NAMES[root]} ${quality}`,
        score: inChord - 0.5 * outOfChord,
        inChord,
        outOfChord
      })
    }
  }
  ranked.sort((a, b) => b.score - a.score)
  return ranked
}

/**
 * Identify chord segments over the 2 Hz chroma series.
 *
 * @param {number[][]} frames one 12-value chroma vector per series step
 * @param {number} hopSec seconds per series step
 * @param {{windowSec?: number, minConfidence?: number}} [options]
 */
export function identifyChords(frames, hopSec, options = {}) {
  const windowSec = options.windowSec ?? 4
  const minConfidence = options.minConfidence ?? 0.35
  const minRunWindows = options.minRunWindows ?? 2
  const minDurationSec = options.minDurationSec ?? 4
  if (!Array.isArray(frames) || frames.length === 0 || !(hopSec > 0)) {
    return { segments: [], windowSec, analysedWindows: 0, note: 'no chroma series to read' }
  }
  const perWindow = Math.max(1, Math.round(windowSec / hopSec))
  const windows = []
  for (let start = 0; start + perWindow <= frames.length; start += perWindow) {
    const sum = new Array(12).fill(0)
    for (let offset = 0; offset < perWindow; offset += 1) {
      const frame = frames[start + offset]
      for (let pitch = 0; pitch < 12; pitch += 1) sum[pitch] += Number(frame[pitch]) || 0
    }
    const ranked = scoreChroma(sum)
    if (ranked.length === 0) continue
    const best = ranked[0]
    const second = ranked.find((entry) => entry.label !== best.label)
    const confidence = second === undefined ? 1 : Math.max(0, Math.min(1, (best.score - second.score) / Math.max(Math.abs(best.score), 1e-6)))
    windows.push({
      startSec: start * hopSec,
      endSec: (start + perWindow) * hopSec,
      label: best.label,
      confidence: Number(confidence.toFixed(3)),
      inChord: Number(best.inChord.toFixed(3))
    })
  }

  // Majority-filter the label sequence over three windows before merging. Without
  // this, a noisy whole-mix chroma flapped between neighbouring triads every
  // window (measured: 48 segments over a 368 s track) and every label looked
  // equally authoritative.
  const smoothed = windows.map((window, index) => {
    const neighbourhood = [windows[index - 1], window, windows[index + 1]].filter(Boolean)
    const counts = new Map()
    for (const entry of neighbourhood) counts.set(entry.label, (counts.get(entry.label) ?? 0) + 1)
    let bestLabel = window.label
    let bestCount = 1
    for (const [label, count] of counts) {
      if (count > bestCount) {
        bestLabel = label
        bestCount = count
      }
    }
    return bestLabel === window.label ? window : { ...window, label: bestLabel }
  })

  // Merge consecutive windows that agree, then drop everything under the floor.
  const merged = []
  for (const window of smoothed) {
    const previous = merged.at(-1)
    if (previous !== undefined && previous.label === window.label) {
      previous.endSec = window.endSec
      previous.confidences.push(window.confidence)
      continue
    }
    merged.push({ label: window.label, startSec: window.startSec, endSec: window.endSec, confidences: [window.confidence] })
  }
  const segments = merged
    .map((segment) => ({
      startSec: Number(segment.startSec.toFixed(2)),
      endSec: Number(segment.endSec.toFixed(2)),
      chord: segment.label,
      confidence: Number((segment.confidences.reduce((sum, value) => sum + value, 0) / segment.confidences.length).toFixed(3)),
      windows: segment.confidences.length
    }))
    .filter((segment) => segment.confidence >= minConfidence)
    .filter((segment) => segment.windows >= minRunWindows)
    .filter((segment) => segment.endSec - segment.startSec >= minDurationSec)
    .map(({ windows: _windows, ...segment }) => segment)

  return {
    segments,
    windowSec,
    analysedWindows: windows.length,
    keptSegments: segments.length,
    minConfidence,
    minRunWindows,
    minDurationSec,
    method: 'major/minor triad templates over the measured chroma series, majority-filtered over three windows; confidence is the margin over the runner-up',
    note: segments.length === 0
      ? 'no chord cleared the confidence floor; the mix may be too percussive for triad detection from chroma'
      : undefined
  }
}
