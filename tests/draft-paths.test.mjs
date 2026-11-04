/**
 * The draft-path leak — model-facing text must never carry a host absolute path.
 *
 * The defect, measured 2026-11-04: dropping an audio or video file inserted
 *
 *   <artifacts>{"transcriptTxt":"/home/<user>/…/transcript.txt"}</artifacts>
 *
 * into the composer draft. The draft is text a human sends or pastes into a
 * chat, ticket or document, so it published the user's own directory layout.
 * Image drops were unaffected because their text carries only the file name.
 * The evidence is not hypothetical: every `artifacts/videos/*\/digest.md` this
 * plugin wrote before the fix contains `"contactSheet":"/home/<user>/…`.
 *
 * Both the tool call and the drag-and-drop route build their text through the
 * same two functions — `transcriptEnvelope` (audio) and `digestText` (video) —
 * so asserting on those two covers both callers.
 *
 * The invariant is stated as a measurement, not a description: an absolute path
 * is a token starting with "/" and containing a second separator.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

const FAKE_ROOT = '/home/somebody/projects/Video_Image_Voice/artifacts'

/** Every absolute path in a blob of text, as literal strings. */
function absolutePathsIn(text) {
  return [...text.matchAll(/(?:^|["'\s:=(,])(\/[A-Za-z0-9._-]+\/[A-Za-z0-9._\-/]*)/gu)].map((match) => match[1])
}

function assertNoAbsolutePath(text, label) {
  const found = absolutePathsIn(text)
  assert.deepEqual(found, [], `${label} still contains absolute path(s): ${found.join(', ')}`)
  assert.ok(!text.includes(homedir()), `${label} contains the real home directory`)
}

/** The JSON inside the one <artifacts> element. */
function artifactsBlock(text) {
  const match = /<artifacts>(.*?)<\/artifacts>/su.exec(text)
  assert.ok(match !== null, 'the text must still publish an <artifacts> element')
  return JSON.parse(match[1])
}

const audioTranscript = {
  model: 'base',
  computeType: 'int8',
  language: 'en',
  languageProbability: 0.97,
  duration: 7.3,
  text: 'and so my fellow americans',
  realTimeFactor: 0.16,
  truncated: false,
  segments: [{ start: 0.5, end: 7.3, text: 'and so my fellow americans' }],
  artifacts: {
    transcriptTxt: `${FAKE_ROOT}/transcripts/jfk.wav-1700000000000/transcript.txt`,
    transcriptJson: `${FAKE_ROOT}/transcripts/jfk.wav-1700000000000/transcript.json`,
    transcriptSrt: `${FAKE_ROOT}/transcripts/jfk.wav-1700000000000/transcript.srt`
  }
}

test('the audio envelope keeps host paths out of model-facing text', async () => {
  const { transcriptEnvelope } = await import('../lib/audio.js')
  const text = transcriptEnvelope('jfk.wav', audioTranscript, 7.3, { artifactsRoot: FAKE_ROOT })

  assertNoAbsolutePath(text, 'the audio envelope')
  // Absence is not enough: the reference must survive, relatively.
  const artifacts = artifactsBlock(text)
  assert.equal(artifacts.transcriptTxt, 'transcripts/jfk.wav-1700000000000/transcript.txt')
  assert.equal(artifacts.transcriptSrt, 'transcripts/jfk.wav-1700000000000/transcript.srt')
})

test('the audio envelope still names the files when no artifacts root is configured', async () => {
  const { transcriptEnvelope } = await import('../lib/audio.js')
  // A caller that forgets the root must not fall back to leaking the path.
  const text = transcriptEnvelope('jfk.wav', audioTranscript, 7.3)
  assertNoAbsolutePath(text, 'the audio envelope without a root')
  assert.equal(artifactsBlock(text).transcriptTxt, 'transcript.txt')
})

const ingestedVideo = {
  dir: `${FAKE_ROOT}/videos/clip.mp4-1700000000000`,
  cuts: [{ timeSec: 5, score: 20 }],
  timeline: [
    { index: 1, start: 0, end: 5, frame: 'shot-01.png' },
    { index: 2, start: 5, end: 11, frame: 'shot-02.png' }
  ],
  contactSheetPath: `${FAKE_ROOT}/videos/clip.mp4-1700000000000/contact-sheet.png`,
  frames: [
    `${FAKE_ROOT}/videos/clip.mp4-1700000000000/frames/shot-01.png`,
    `${FAKE_ROOT}/videos/clip.mp4-1700000000000/frames/shot-02.png`
  ],
  transcript: null,
  transcriptNote: 'no speech detected in the audio track'
}

test('the video digest keeps host paths out of model-facing text', async () => {
  const { digestText } = await import('../lib/video.js')
  const text = digestText(
    { displayPath: 'clip.mp4' },
    { durationSeconds: 11 },
    ingestedVideo,
    { canSeeImages: false, artifactsRoot: FAKE_ROOT }
  )

  assertNoAbsolutePath(text, 'the video digest')
  const artifacts = artifactsBlock(text)
  assert.equal(artifacts.contactSheet, 'videos/clip.mp4-1700000000000/contact-sheet.png')
  assert.deepEqual(artifacts.frames, [
    'videos/clip.mp4-1700000000000/frames/shot-01.png',
    'videos/clip.mp4-1700000000000/frames/shot-02.png'
  ])
})

test('a relative artifact reference the plugin prints resolves back to the real file', async () => {
  const { digestText } = await import('../lib/video.js')
  const { resolveMediaTarget } = await import('../lib/fsutil.js')

  // A real artifacts root on disk, so the round trip is measured, not assumed.
  // Removed in `finally`: a test that leaves a temp directory every run litters the machine it
  // is proving itself on (twenty `mr-draft-paths-*` dirs were found at shutdown).
  const root = await mkdtemp(join(tmpdir(), 'mr-draft-paths-'))
  try {
  const jobDir = join(root, 'videos', 'clip.mp4-1700000000000')
  await mkdir(join(jobDir, 'frames'), { recursive: true })
  const sheet = join(jobDir, 'contact-sheet.png')
  await writeFile(sheet, 'png')

  const ingested = {
    ...ingestedVideo,
    dir: jobDir,
    contactSheetPath: sheet,
    frames: [join(jobDir, 'frames', 'shot-01.png'), join(jobDir, 'frames', 'shot-02.png')]
  }
  const text = digestText({ displayPath: 'clip.mp4' }, { durationSeconds: 11 }, ingested, {
    canSeeImages: false,
    artifactsRoot: root
  })
  const reference = artifactsBlock(text).contactSheet
  assert.ok(reference.endsWith('contact-sheet.png'), 'the reference must still name the file')
  assert.equal(isAbsolute(reference), false, `the printed reference is absolute: ${reference}`)

  // The handoff the digest advertises ("call media_image on the frame path") only
  // works if the plugin can resolve what it printed.
  const ctx = {
    fs: {
      resolve: async (requestedPath, options) => ({
        targetKey: isAbsolute(requestedPath) ? requestedPath : join(options?.cwd ?? '/workspace', requestedPath),
        displayPath: requestedPath
      }),
      stat: async (target) => {
        try {
          const info = await stat(target.targetKey)
          return { type: info.isFile() ? 'file' : 'directory', size: info.size }
        } catch {
          return undefined
        }
      },
      processPath: (target) => target.targetKey
    }
  }
  const exec = { agent: { session: { header: { cwd: '/workspace' } } } }
  const resolved = await resolveMediaTarget(ctx, exec, reference, { artifactsDir: root })
  assert.equal(resolved.processPath, sheet)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the artifacts fallback does not resolve a path that exists in neither place', async () => {
  const { resolveMediaTarget } = await import('../lib/fsutil.js')
  const ctx = {
    fs: {
      resolve: async (requestedPath, options) => ({
        targetKey: isAbsolute(requestedPath) ? requestedPath : join(options?.cwd ?? '/workspace', requestedPath),
        displayPath: requestedPath
      }),
      stat: async () => undefined,
      processPath: (target) => target.targetKey
    }
  }
  const exec = { agent: { session: { header: { cwd: '/workspace' } } } }
  await assert.rejects(
    () => resolveMediaTarget(ctx, exec, 'videos/nope/shot-01.png', { artifactsDir: '/tmp/does-not-exist-artifacts' }),
    /NOT_FOUND|not found/u
  )
})

/**
 * Unit tests prove the two builders behave; only the wiring proves the drop
 * route reaches them, because the route calls them through `config`. Both a
 * presence assertion (the root is passed) and an absence assertion (the old
 * leaking interpolation is gone) are needed: either alone passes on a tree that
 * still leaks.
 */
test('the drop route and every digest caller hand the artifacts root to the builders', async () => {
  const { readFile } = await import('node:fs/promises')
  const sources = {}
  for (const name of ['audio.js', 'video.js', 'upload.js', 'index.js']) {
    sources[name] = await readFile(new URL(`../lib/${name}`, import.meta.url), 'utf8')
  }

  for (const [name, source] of Object.entries(sources)) {
    assert.equal(
      source.includes('JSON.stringify(transcript.artifacts)'),
      false,
      `lib/${name} still interpolates raw artifact paths into model-facing text`
    )
  }

  assert.match(sources['upload.js'], /transcriptEnvelope\([^)]*artifactsRoot: config\.artifactsDir/u)
  assert.match(sources['upload.js'], /resolveMediaTarget\([^)]*artifactsDir: config\.artifactsDir/u)
  // Both digest callers: the tool and the drop route.
  assert.equal(
    (sources['video.js'].match(/artifactsRoot: config\.artifactsDir/gu) ?? []).length,
    2,
    'video.js must hand the artifacts root to both digestText callers'
  )
})

