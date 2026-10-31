/**
 * REPLICATION.md — the human-readable half of the pack.
 *
 * Written for two readers: the operator deciding whether the measurement is good
 * enough to generate from, and the next agent that has to extend it. Every row
 * carries its evidence tag, every unmeasured field is stated rather than omitted,
 * and no section is allowed to imply a generation happened.
 */
const BADGE = {
  MEASURED: '**MEASURED**',
  INFERRED: '**INFERRED**',
  UNVERIFIED: '_UNVERIFIED_'
}

function badge(tag) {
  return BADGE[tag] ?? `_${tag}_`
}

function value(cell) {
  if (cell === null || cell === undefined) return '—'
  if (Array.isArray(cell)) {
    if (cell.length === 0) return '—'
    if (cell.every((entry) => typeof entry === 'number')) return cell.map((entry) => round(entry, 3)).join(', ')
    return `${cell.length} entries (see replication.json)`
  }
  if (typeof cell === 'object') return '—'
  return String(cell)
}

function round(value, digits) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/** A null measurement prints as a dash, never as the word "null". */
function fmt(value) {
  return value === null || value === undefined ? '—' : String(value)
}

function relative(jobDir, path) {
  if (typeof path !== 'string') return '—'
  return path.startsWith(jobDir) ? path.slice(jobDir.length + 1) : path
}

/**
 * @param {object} input
 * @returns {string} markdown
 */
export function renderReplicationMarkdown(input) {
  const { pack, plan, jobDir, sourceName, timings, skipped, artifacts } = input
  const music = pack.music
  const video = pack.video
  // `music`/`video` are either a block of tagged fields or a single tagged field
  // saying the file has no such stream. `'tempo' in music` is what separates the
  // two; testing for an object alone rendered an empty table and then threw.
  const hasMusic = typeof music === 'object' && music !== null && 'tempo' in music
  const hasVideo = typeof video === 'object' && video !== null && 'shotCount' in video
  const lines = []

  lines.push(`# Replication evidence pack — ${sourceName}`)
  lines.push('')
  lines.push(`Generated ${pack.generatedAt} · mode **${pack.mode}** · profile **${pack.profile}**`)
  lines.push('')
  lines.push('> Every field below carries an evidence tag. **MEASURED** came out of the samples or the pixels,')
  lines.push('> **INFERRED** is a measurement that is not decisive, and **_UNVERIFIED_** is a field this pack does')
  lines.push('> not claim. No generation call was made to produce this document.')
  lines.push('')

  lines.push('## Source')
  lines.push('')
  lines.push('| Field | Value | Evidence |')
  lines.push('|---|---|---|')
  lines.push(`| File | \`${pack.source.path}\` | ${badge('MEASURED')} |`)
  lines.push(`| Bytes | ${pack.source.bytes} | ${badge('MEASURED')} |`)
  lines.push(`| SHA-256 | \`${pack.source.sha256}\` | ${badge('MEASURED')} |`)
  lines.push(`| Container | ${pack.source.container} | ${badge('MEASURED')} |`)
  lines.push(`| Duration | ${pack.source.durationSeconds}s | ${badge('MEASURED')} |`)
  if (pack.source.video !== null) {
    const v = pack.source.video
    lines.push(`| Video | ${v.codec} ${v.width}×${v.height} @ ${v.fps} fps | ${badge('MEASURED')} |`)
  }
  if (pack.source.audio !== null) {
    const a = pack.source.audio
    lines.push(`| Audio | ${a.codec} ${a.sampleRate} Hz ${a.channels}ch | ${badge('MEASURED')} |`)
  }
  lines.push('')

  if (hasMusic) {
    lines.push('## Audio measurements')
    lines.push('')
    lines.push('| Field | Value | Evidence | Note |')
    lines.push('|---|---|---|---|')
    for (const [label, key] of [
      ['Tempo', 'tempo'],
      ['Key', 'key'],
      ['Loudness', 'loudness'],
      ['Energy', 'energy'],
      ['Timbre', 'timbre'],
      ['Rhythm onsets', 'onsets'],
      ['Instruments', 'instruments'],
      ['Genre / vibe', 'genreVibe']
    ]) {
      const tagged = music[key]
      if (tagged === undefined) continue
      const cell = key === 'loudness' && tagged.value !== null
        ? `${fmt(tagged.value.integratedLufs)} LUFS (LRA ${fmt(tagged.value.loudnessRangeLu)} LU, peak ${fmt(tagged.value.truePeakDbfs)} dBFS)`
        : key === 'energy' && tagged.value !== null
          ? `RMS ${tagged.value.rmsDb} dBFS, dynamic range ${tagged.value.dynamicRangeDb} dB`
          : key === 'timbre' && tagged.value !== null
            ? `harmonic/percussive ratio ${tagged.value.harmonicPercussiveRatio}`
            : key === 'onsets' && tagged.value !== null
              ? `${tagged.value.count} onsets (${tagged.value.ratePerSec}/s)`
              : value(tagged.value)
      lines.push(`| ${label} | ${cell} | ${badge(tagged.evidence)} | ${tagged.note ?? ''} |`)
    }
    lines.push('')

    if (Array.isArray(music.chords?.value) && music.chords.value.length > 0) {
      lines.push('### Chords')
      lines.push('')
      lines.push(`Evidence: ${badge(music.chords.evidence)} — ${music.chords.note}`)
      lines.push('')
      lines.push('| Start | End | Chord | Confidence |')
      lines.push('|---|---|---|---|')
      for (const segment of music.chords.value.slice(0, 24)) {
        lines.push(`| ${segment.startSec}s | ${segment.endSec}s | ${segment.chord} | ${segment.confidence} |`)
      }
      if (music.chords.value.length > 24) {
        lines.push(`| … | … | ${music.chords.value.length - 24} more segments | |`)
      }
      lines.push('')
    }

    if (typeof music.stems?.value === 'object' && music.stems.value !== null) {
      lines.push('### Stems')
      lines.push('')
      lines.push(`Evidence: ${badge(music.stems.evidence)} — ${music.stems.note}`)
      lines.push('')
      lines.push('| Stem | File | Size | Measured tempo | Measured key | Energy |')
      lines.push('|---|---|---|---|---|---|')
      for (const stem of music.stems.value.stems) {
        const measured = stem.measured ?? {}
        lines.push(
          `| ${stem.label} | \`${relative(jobDir, stem.file)}\` | ${(stem.bytes / 1e6).toFixed(1)} MB | ` +
          `${measured.tempo === null || measured.tempo === undefined ? '—' : `${measured.tempo} BPM`} | ` +
          `${measured.key ?? '—'} | ${measured.energyRmsDb === null || measured.energyRmsDb === undefined ? '—' : `${measured.energyRmsDb} dBFS`} |`
        )
      }
      lines.push('')
    }

    const semantic = music.semantic
    if (typeof semantic?.value === 'object' && semantic.value !== null) {
      lines.push('### Interpretation (assisted semantic pass)')
      lines.push('')
      lines.push(`Evidence: ${badge(semantic.evidence)} — ${semantic.note}`)
      lines.push('')
      const value = semantic.value
      lines.push('| Field | Value |')
      lines.push('|---|---|')
      lines.push(`| Genre | ${value.genre ?? '—'} |`)
      lines.push(`| Vibe / mood | ${[value.vibe, value.mood].filter(Boolean).join(' · ') || '—'} |`)
      lines.push(`| Era | ${value.era ?? '—'} |`)
      if (Array.isArray(value.instruments) && value.instruments.length > 0) {
        lines.push(`| Instruments (hypotheses) | ${value.instruments.map((entry) => `${entry.name}${entry.confidence === null ? '' : ` (${entry.confidence})`}`).join(', ')} |`)
      }
      if (value.vocal !== null && typeof value.vocal === 'object') {
        lines.push(`| Vocal delivery | ${value.vocal.delivery ?? '—'} |`)
        lines.push(`| Vocal register | ${value.vocal.register ?? '—'} |`)
        lines.push(`| Flow notes | ${value.vocal.flowNotes ?? '—'} |`)
        lines.push(`| Ad-libs / effects | ${[value.vocal.adlibs, value.vocal.effects].filter(Boolean).join(' · ') || '—'} |`)
      }
      if (Array.isArray(value.sections) && value.sections.length > 0) {
        lines.push(`| Structural roles (hypotheses) | ${value.sections.map((entry) => `${entry.startSec}–${entry.endSec}s ${entry.role}`).join('; ')} |`)
      }
      if (value.mix?.notes !== null && value.mix?.notes !== undefined) {
        lines.push(`| Mix notes | ${value.mix.notes} |`)
      }
      lines.push('')
      if (Array.isArray(value.cautions) && value.cautions.length > 0) {
        lines.push('Model cautions:')
        lines.push('')
        for (const caution of value.cautions) lines.push(`- ${caution}`)
        lines.push('')
      }
    }

    const cadence = music.cadence
    if (cadence?.value !== null && cadence?.value !== undefined) {
      lines.push('### Cadence')
      lines.push('')
      lines.push(`Evidence: ${badge(cadence.evidence)} — ${cadence.note}`)
      lines.push('')
      lines.push('| Measure | Value |')
      lines.push('|---|---|')
      const c = cadence.value
      const rows = [
        ['Median inter-onset interval', c.ioiMedianSec === undefined ? null : `${c.ioiMedianSec} s`],
        ['25th / 75th percentile IOI', c.ioiP25Sec === undefined ? null : `${c.ioiP25Sec} / ${c.ioiP75Sec} s`],
        ['Most common subdivision', c.dominantIoiSec === undefined ? null : `${c.dominantIoiSec} s`],
        ['Accent per 4 beats', c.accentPer4Beats ?? null],
        ['Accent per 3 beats', c.accentPer3Beats ?? null],
        ['Accent spread (4)', c.accentSpread4 === undefined ? null : c.accentSpread4],
        ['Alternate-beat difference', c.beatAlternationRatio === undefined ? null : c.beatAlternationRatio],
        ['Deviation from the eighth-note grid', c.gridDeviationMedianMs === undefined ? null : `${c.gridDeviationMedianMs} ms`]
      ]
      for (const [label, cell] of rows) lines.push(`| ${label} | ${value(cell)} |`)
      lines.push('')
      if (typeof c.accentCaveat === 'string') {
        lines.push(`> ${c.accentCaveat}`)
        lines.push('')
      }
    }

    const sections = music.sections
    if (Array.isArray(sections?.value) && sections.value.length > 0) {
      lines.push('### Regions')
      lines.push('')
      lines.push(`Evidence: ${badge(sections.evidence)} — ${sections.note}`)
      lines.push('')
      lines.push('| # | Start | End | Energy dB | Harmonic ratio | Top pitch classes |')
      lines.push('|---|---|---|---|---|---|')
      for (const section of sections.value) {
        lines.push(`| ${section.index} | ${section.startSec}s | ${section.endSec}s | ${section.energyDb} | ${section.harmonicRatio} | ${(section.topPitchClasses ?? []).join(' ')} |`)
      }
      lines.push('')
    }
  }

  if (hasVideo) {
    lines.push('## Video')
    lines.push('')
    lines.push(`Shots: ${badge(video.shotCount.evidence)} detected ${video.shotCount.value.detected}, sampled ${video.shotCount.value.sampled} — ${video.shotCount.note}`)
    lines.push('')
    if (typeof video.inventory?.value === 'object' && video.inventory.value !== null) {
      lines.push(`Inventory: ${badge(video.inventory.evidence)} ${video.inventory.value.detected} boundaries, median ${video.inventory.value.medianShotSec}s, longest ${video.inventory.value.longestShotSec}s — every boundary is in \`shots.json\``)
      lines.push('')
    }
    if (Array.isArray(video.pilotShots?.value) && video.pilotShots.value.length > 0) {
      lines.push(`Pilot clips: ${badge(video.pilotShots.evidence)} — ${video.pilotShots.note}`)
      lines.push('')
      lines.push('| Detected shot | Clip start | Clip end | Seconds | Whole shot |')
      lines.push('|---|---|---|---|---|')
      for (const pilot of video.pilotShots.value) {
        lines.push(`| ${pilot.detectedShot} | ${pilot.startSec}s | ${pilot.endSec}s | ${pilot.durationSec} | ${pilot.wholeShot ? 'yes' : 'window inside the shot'} |`)
      }
      lines.push('')
    }
    lines.push('| # (detected) | Start | End | Mid frame | Mean luma | Dominant colours | Camera | Action | Transition | On-screen text |')
    lines.push('|---|---|---|---|---|---|---|---|---|---|')
    // Print the graded field with its own tag. An earlier version hardcoded
    // _UNVERIFIED_ in this column, so a pack whose JSON held real descriptions
    // still rendered "unverified" — the report contradicted its own data.
    // A model's answer can contain newlines (the on-screen text came back as two
    // lines) and a raw newline breaks the table row in the rendered document.
    const oneLine = (text) => String(text).replace(/\s*[\r\n]+\s*/gu, ' / ').trim()
    const cell = (tagged) => (tagged === undefined || tagged === null
      ? '—'
      : `${tagged.value === null || tagged.value === undefined ? '—' : oneLine(tagged.value).replace(/\|/gu, '\\|')} ${badge(tagged.evidence)}`)
    let describedShots = 0
    for (const shot of video.shots) {
      const mid = shot.frames.find((frame) => frame.role === 'mid')
      const light = shot.lighting?.value ?? null
      if (shot.camera?.evidence === 'INFERRED' || shot.action?.evidence === 'INFERRED') describedShots += 1
      lines.push(
        `| ${shot.index} (${shot.detectedShot}) | ${shot.startSec.value}s | ${shot.endSec.value}s | \`${relative(jobDir, mid?.file ?? null)}\` | ` +
        `${light === null ? '—' : light.meanLuma} | ${light === null ? '—' : light.dominant.map((colour) => colour.hex).join(' ')} | ` +
        `${cell(shot.camera)} | ${cell(shot.action)} | ${cell(shot.transition)} | ${cell(shot.ocr)} |`
      )
    }
    lines.push('')
    if (describedShots > 0) {
      lines.push(`${describedShots} of ${video.shots.length} sampled shots carry an interpretation from the assisted semantic pass,`)
      lines.push('tagged **INFERRED**: a model described the attached keyframes, it did not measure them. Shots without')
      lines.push('a description were not among the frames sent (the semantic pass reads a budgeted subset).')
    } else {
      lines.push('Camera movement, action, lighting design, transition type and on-screen text are **_UNVERIFIED_**.')
      lines.push('They need a native video model (profile `assisted`/`cloud`) or the operator; a frame statistic cannot establish them.')
    }
    lines.push('')
  }

  if (!hasMusic) {
    lines.push('## Audio measurements')
    lines.push('')
    lines.push(`${badge('UNVERIFIED')} — ${music?.note ?? 'this file has no audio stream'}`)
    lines.push('')
  }
  if (!hasVideo) {
    lines.push('## Video')
    lines.push('')
    lines.push(`${badge('UNVERIFIED')} — ${video?.note ?? 'this file has no video stream'}`)
    lines.push('')
  }

  const lyrics = pack.lyrics
  lines.push('## Lyrics')
  lines.push('')
  lines.push(`Evidence: ${badge(lyrics.evidence)} — ${lyrics.note ?? ''}`)
  lines.push('')
  if (lyrics.value === null || lyrics.value.text === '') {
    lines.push('_No transcript was produced._')
  } else {
    const summary = lyrics.value.summary
    lines.push(`| Measure | Value |`)
    lines.push('|---|---|')
    lines.push(`| Segments | ${summary.segments} |`)
    lines.push(`| Words | ${summary.words} |`)
    lines.push(`| Language | ${lyrics.value.language} |`)
    lines.push(`| Mean log-probability | ${summary.meanAvgLogprob} |`)
    lines.push(`| Mean no-speech probability | ${summary.meanNoSpeechProb} |`)
    lines.push(`| Verdict | ${summary.verdict} |`)
    lines.push('')
    lines.push('```text')
    const text = lyrics.value.text
    lines.push(text.length > 1600 ? `${text.slice(0, 1600)}\n… (${text.length} characters in total, see lyrics/)` : text)
    lines.push('```')
  }
  lines.push('')

  lines.push('## What is not in this pack')
  lines.push('')
  const unmeasured = pack.unmeasured ?? {}
  const unmeasuredKeys = Object.keys(unmeasured)
  if (unmeasuredKeys.length === 0 && skipped.length === 0) {
    lines.push('_Nothing was skipped._')
  } else {
    lines.push('| Stage | Why |')
    lines.push('|---|---|')
    for (const [stage, reason] of Object.entries(unmeasured)) lines.push(`| ${stage} (worker) | ${reason} |`)
    for (const entry of skipped) lines.push(`| ${entry.stage} | ${entry.reason} |`)
  }
  lines.push('')

  lines.push('## How to use this pack')
  lines.push('')
  lines.push(`Mode **${pack.mode}** — preserve these measured anchors:`)
  lines.push('')
  for (const entry of plan.preserve) lines.push(`- \`${entry}\``)
  lines.push('')
  if (Array.isArray(plan.preserveWithCaution) && plan.preserveWithCaution.length > 0) {
    lines.push('Measured but not decisive — evaluate against these, do not treat them as ground truth:')
    lines.push('')
    for (const entry of plan.preserveWithCaution) lines.push(`- \`${entry}\``)
    lines.push('')
  }
  lines.push(`A change has not been stated${plan.change.length === 0 ? ' (that is deliberate — see plan.json)' : ''}.`)
  lines.push('')
  lines.push('Evaluation targets for a generated take:')
  lines.push('')
  for (const entry of plan.evaluation) lines.push(`- ${entry}`)
  lines.push('')
  lines.push('Reference material a generator can consume from this job:')
  lines.push('')
  lines.push(`- audio (lossless): \`${relative(jobDir, artifacts.referenceAudio ?? null)}\``)
  lines.push(`- audio (DSP input, 22.05 kHz mono): \`${relative(jobDir, artifacts.dspWav ?? null)}\``)
  lines.push(`- shot frames: \`frames/\``)
  lines.push(`- lyrics: \`lyrics/\``)
  lines.push('')

  lines.push('## Limits of this document')
  lines.push('')
  lines.push('- No exact-reproduction claim is made anywhere. A generator produces a *new* recording.')
  lines.push('- Tempo, key and rhythm cannot be measured with certainty from audio alone; the numbers above are')
  lines.push('  the pack\'s best measurement and their confidence is stated next to them.')
  lines.push('- Nothing here is a legal opinion about the source. Rights were confirmed by the operator for testing.')
  lines.push('')
  lines.push('## Timings')
  lines.push('')
  lines.push('| Stage | ms |')
  lines.push('|---|---|')
  for (const [stage, ms] of Object.entries(timings)) lines.push(`| ${stage} | ${ms} |`)
  lines.push('')
  return lines.join('\n')
}
