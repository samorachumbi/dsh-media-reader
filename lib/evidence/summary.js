/**
 * The model-facing text for `media_evidence`.
 *
 * Deliberately structured by evidence strength rather than by media type: what
 * was measured first, what is uncertain second, what is not claimed last. A model
 * that reads only the top of this result still cannot mistake a guess for a
 * measurement, because the guess is never printed in the measured block.
 */
import { EVIDENCE } from './pack.js'

function num(value, digits = 2) {
  return Number.isFinite(value) ? Number(value).toFixed(digits).replace(/\.?0+$/u, '') : '—'
}

function tagged(value, tag) {
  if (value === null || value === undefined) return '—'
  return `${value}  [${tag}]`
}

/**
 * @param {object} result the return value of buildEvidencePack
 * @returns {string}
 */
export function formatEvidenceSummary(result) {
  const pack = result.pack
  const plan = result.plan
  const music = pack.music !== null && typeof pack.music === 'object' && 'tempo' in pack.music ? pack.music : null
  const video = pack.video !== null && typeof pack.video === 'object' && 'shotCount' in pack.video ? pack.video : null
  const lines = []

  lines.push(`EVIDENCE PACK — ${pack.source.durationSeconds}s · mode ${pack.mode} · profile ${pack.profile}`)
  lines.push(`sha256 ${String(pack.source.sha256 ?? '').slice(0, 16)}…  ·  no generation call was made`)

  if (music === null) {
    lines.push('')
    lines.push('AUDIO: none — this file has no audio stream.')
  } else {
    const measured = []
    const inferred = []
    const unverified = []

    // Each entry is filed by its OWN tag. An earlier version pushed everything
    // that was not MEASURED into the INFERRED block, which printed an
    // [UNVERIFIED] tempo under an "INFERRED" heading — a grouping lie in the one
    // place the reader is meant to trust the grouping.
    const file = (entry, line) => {
      if (entry.evidence === EVIDENCE.MEASURED) measured.push(line)
      else if (entry.evidence === EVIDENCE.INFERRED) inferred.push(line)
      else unverified.push(line)
    }

    const tempo = music.tempo
    file(tempo, tempo.value === null
      ? `tempo: —  [${tempo.evidence}] ${tempo.note ?? ''}`.trim()
      : `tempo: ${num(tempo.value)} BPM  [${tempo.evidence}]${tempo.note === undefined ? '' : `\n    ${tempo.note}`}`)

    for (const [label, entry, format] of [
      ['key', music.key, (v) => v],
      ['loudness', music.loudness, (v) => `${num(v.integratedLufs, 1)} LUFS (LRA ${num(v.loudnessRangeLu, 1)} LU, peak ${num(v.truePeakDbfs, 1)} dBFS)`],
      ['energy', music.energy, (v) => `RMS ${num(v.rmsDb, 1)} dBFS, dynamic range ${num(v.dynamicRangeDb, 1)} dB`],
      ['timbre', music.timbre, (v) => `harmonic/percussive ratio ${num(v.harmonicPercussiveRatio, 3)}`],
      ['onsets', music.onsets, (v) => `${v.count} loudness onsets (${num(v.ratePerSec, 2)}/s)`],
      ['regions', music.sections, (v) => `${v.length} novelty regions`]
    ]) {
      file(entry, entry.value === null
        ? `${label}: —  [${entry.evidence}] ${entry.note ?? ''}`.trim()
        : `${label}: ${tagged(format(entry.value), entry.evidence)}`)
    }

    const cadence = music.cadence
    if (cadence.value !== null) {
      const c = cadence.value
      const parts = []
      if (Number.isFinite(c.ioiMedianSec)) parts.push(`IOI ${num(c.ioiMedianSec, 3)}s`)
      if (Number.isFinite(c.dominantIoiSec)) parts.push(`subdivision ${num(c.dominantIoiSec, 3)}s`)
      if (Number.isFinite(c.beatAlternationRatio)) parts.push(`alternate-beat ${num(c.beatAlternationRatio, 3)}`)
      if (Number.isFinite(c.accentSpread4)) parts.push(`accent spread ${num(c.accentSpread4, 3)}`)
      file(cadence, `cadence: ${parts.join(', ')}  [${cadence.evidence}]`)
    }

    unverified.push(`instruments: —  [${music.instruments.evidence}] ${music.instruments.note ?? ''}`)
    unverified.push(`genre/vibe: —  [${music.genreVibe.evidence}] ${music.genreVibe.note ?? ''}`)

    if (Array.isArray(music.chords?.value) && music.chords.value.length > 0) {
      const first = music.chords.value.slice(0, 4).map((segment) => `${segment.chord}@${segment.startSec}s`).join(', ')
      const line = `chords: ${music.chords.value.length} segments (${first}${music.chords.value.length > 4 ? ', …' : ''})  [${music.chords.evidence}]`
      if (music.chords.evidence === EVIDENCE.MEASURED) measured.push(line)
      else inferred.push(line)
    }
    if (typeof music.stems?.value === 'object' && music.stems.value !== null) {
      const labels = music.stems.value.stems.map((stem) => stem.label).join(', ')
      measured.push(`stems: ${music.stems.value.stems.length} separated (${labels})  [${music.stems.evidence}]`)
    }
    const semantic = music.semantic
    if (typeof semantic?.value === 'object' && semantic.value !== null) {
      const value = semantic.value
      const parts = []
      if (value.genre !== null) parts.push(`genre ${value.genre}`)
      if (value.vibe !== null) parts.push(`vibe ${value.vibe}`)
      if (Array.isArray(value.instruments) && value.instruments.length > 0) {
        parts.push(`instruments ${value.instruments.map((entry) => entry.name).join('/')}`)
      }
      inferred.push(`semantic: ${parts.join(', ') || 'returned no usable fields'}  [${semantic.evidence}] (${semantic.model})`)
    }
    if (measured.length > 0) {
      lines.push('')
      lines.push('MEASURED (computed from the samples)')
      for (const line of measured) lines.push(`  ${line}`)
    }
    if (inferred.length > 0) {
      lines.push('')
      lines.push('INFERRED (measured, not decisive — do not quote as fact)')
      for (const line of inferred) lines.push(`  ${line}`)
    }
    if (unverified.length > 0) {
      lines.push('')
      lines.push('NOT CLAIMED (no measurement stands behind these)')
      for (const line of unverified) lines.push(`  ${line}`)
    }
    const window = music.analysisWindow
    lines.push('')
    lines.push(`coverage: ${num(window.value.audioSeconds, 2)}s of ${num(window.value.fileDurationSeconds, 2)}s analysed  [${window.evidence}]${window.value.truncated === true ? '  ← TRUNCATED' : ''}`)
  }

  if (video === null) {
    lines.push('')
    lines.push('VIDEO: none — this file has no video stream.')
  } else {
    lines.push('')
    lines.push(`VIDEO (shots: ${video.shotCount.value.sampled} of ${video.shotCount.value.detected} sampled)  [${video.shotCount.evidence}]`)
    lines.push('  Each shot has real start/mid/end frames on disk plus measured luma and dominant colours.')
    const described = (video.shots ?? []).filter((shot) => shot.camera?.evidence === EVIDENCE.INFERRED).length
    if (described > 0) {
      lines.push(`  camera/action/transition/on-screen text: [${EVIDENCE.INFERRED}] for ${described} sampled shot(s) by the semantic pass — hypothesis, not measurement`)
    } else {
      lines.push(`  camera, action, lighting design, transition type and on-screen text: [_${EVIDENCE.UNVERIFIED}_] — no video model and no OCR ran, so they are not described`)
    }
    if (Array.isArray(video.pilotShots?.value) && video.pilotShots.value.length > 0) {
      const pilots = video.pilotShots.value.map((pilot) => `#${pilot.detectedShot} ${pilot.startSec}-${pilot.endSec}s`).join(', ')
      lines.push(`  pilot clips for generation: ${pilots}  [${EVIDENCE.MEASURED}]`)
    }
  }

  const lyrics = pack.lyrics
  lines.push('')
  if (lyrics.value === null || lyrics.value.text === undefined) {
    lines.push(`LYRICS: none  [${lyrics.evidence}] ${lyrics.note ?? ''}`)
  } else {
    const summary = lyrics.value.summary
    lines.push(`LYRICS: ${summary.words} words · verdict ${summary.verdict} · mean log-probability ${num(summary.meanAvgLogprob, 2)}  [${lyrics.evidence}]`)
    lines.push(`  "…${lyrics.value.text.slice(0, 160).trim()}…"`)
    lines.push(`  ${lyrics.note ?? ''}`)
  }

  if (Array.isArray(pack.skipped) && pack.skipped.length > 0) {
    lines.push('')
    lines.push('NOT RUN (stated, not silently missing)')
    for (const entry of pack.skipped) lines.push(`  ${entry.stage}: ${entry.reason}`)
  }

  lines.push('')
  lines.push(`preserve anchors (${plan.preserve.length} measured): ${plan.preserve.join(', ') || 'none'}`)
  if (Array.isArray(plan.preserveWithCaution) && plan.preserveWithCaution.length > 0) {
    lines.push(`preserve with caution (${plan.preserveWithCaution.length} inferred): ${plan.preserveWithCaution.join(', ')}`)
  }
  lines.push(`change: none stated — a transformation must be described before any generation call`)
  lines.push('')
  lines.push(`read the full pack: ${result.paths.replicationMd}`)
  lines.push(`machine-readable:  ${result.paths.replicationJson}`)
  return lines.join('\n')
}
