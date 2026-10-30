/**
 * End-to-end: build a real pack from a real media file with the real tools.
 *
 * The unit tests prove the parsers and graders; this proves the assembly — that
 * the stages actually run, that the artifact tree is written, and that the
 * analysis covers the whole file instead of silently truncating it.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildEvidencePack } from '../lib/evidence/index.js'
import { EVIDENCE } from '../lib/evidence/pack.js'
import { createNodeRunner } from '../lib/evidence/runner.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROJECT = join(HERE, '..')
const FIXTURE = join(PROJECT, 'fixtures', 'error-demo.mp4')
const ffmpeg = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' })
const skipReason = ffmpeg.status === 0 ? false : 'ffmpeg is not available'

// One build for both tests: the stage is slow, the assertions are not.
let built
async function buildOnce() {
  if (built !== undefined) return built
  const outDir = mkdtempSync(join(tmpdir(), 'evidence-pack-'))
  const result = await buildEvidencePack({
    run: createNodeRunner(),
    filePath: FIXTURE,
    outDir,
    job: 'fixture-job',
    mode: 'replica',
    profile: 'local',
    lyrics: false,
    keepReferenceAudio: true,
    maxShots: 4
  })
  built = { outDir, result }
  return built
}

test('the pack writes its whole artifact tree', { skip: skipReason }, async () => {
  const { result } = await buildOnce()
  for (const path of [
    result.paths.sourceJson,
    result.paths.audioFeaturesJson,
    result.paths.replicationJson,
    result.paths.planJson,
    result.paths.replicationMd,
    result.paths.skippedJson
  ]) {
    assert.ok(existsSync(path), `missing artifact: ${path}`)
  }
  const pack = JSON.parse(readFileSync(result.paths.replicationJson, 'utf8'))
  const plan = JSON.parse(readFileSync(result.paths.planJson, 'utf8'))
  assert.equal(pack.schema, 'dsh-media-reader/replication@1')
  assert.equal(pack.mode, 'replica')
  assert.equal(pack.profile, 'local')
  assert.equal(plan.generation, null)
  assert.deepEqual(plan.change, [])
  assert.ok(plan.preserve.length > 0, 'the plan must preserve the measured fields')
  // The frame files the pack points at must exist on disk.
  const frames = readdirSync(join(result.jobDir, 'frames'))
  assert.ok(frames.length >= 3, `expected at least 3 frames, found ${frames.length}`)
  for (const shot of pack.video.shots) {
    const mid = shot.frames.find((frame) => frame.role === 'mid')
    assert.ok(existsSync(mid.file), `missing mid frame for shot ${shot.index}`)
  }
})

test('analysis covers the whole file and every claim is tagged', { skip: skipReason }, async () => {
  const { result } = await buildOnce()
  const pack = result.pack
  const features = JSON.parse(readFileSync(result.paths.audioFeaturesJson, 'utf8'))
  const duration = pack.source.durationSeconds
  assert.ok(duration > 0)
  // The defect this asserts against: a 300 s cap silently applied to a longer
  // file. Coverage must match the file, and `truncated` must be false.
  assert.equal(features.audio.truncated, false)
  assert.ok(
    Math.abs(features.analysis.audioSeconds - duration) < 0.25,
    `analysed ${features.analysis.audioSeconds}s of a ${duration}s file`
  )
  assert.equal(pack.music.analysisWindow.evidence, EVIDENCE.MEASURED)

  const walk = (node, path) => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      node.forEach((entry, index) => walk(entry, `${path}[${index}]`))
      return
    }
    if ('evidence' in node) {
      assert.ok(
        [EVIDENCE.MEASURED, EVIDENCE.INFERRED, EVIDENCE.UNVERIFIED].includes(node.evidence),
        `field ${path} has an invalid evidence tag: ${node.evidence}`
      )
      if (node.evidence !== EVIDENCE.UNVERIFIED && node.value === null) {
        assert.fail(`field ${path} claims ${node.evidence} but carries no value`)
      }
      return
    }
    for (const [key, value] of Object.entries(node)) walk(value, `${path}.${key}`)
  }
  walk(pack.video, 'video')
  walk(pack.music, 'music')

  // Stages that did not run must be named, not omitted.
  const skipped = readFileSync(result.paths.skippedJson, 'utf8')
  assert.match(skipped, /Demucs/u)
  assert.match(skipped, /Basic Pitch/u)
  assert.match(skipped, /generation/u)
  assert.equal(pack.lyrics.evidence, EVIDENCE.UNVERIFIED, 'lyrics were requested off')

  rmSync(result.jobDir, { recursive: true, force: true })
})
