/**
 * Offline contracts for the Kie generation adapter.
 *
 * No test here touches the network or spends a credit. The mocked lifecycle
 * proves that the gate fires before upload, the request uses the documented
 * shapes, outputs are archived, and the ledger cannot leak the credential.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { open, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendLedger } from '../lib/kie/client.js'
import {
  assertBudgetAvailable,
  assertGenerationEnabled,
  assertTotalBudgetAvailable,
  buildAnimateReplaceInput,
  buildCoverInput,
  buildMusicGenerateInput,
  buildReferenceVideoInput,
  collectGeneratedOutputs,
  evaluateBudget,
  evaluateTotalBudget,
  executeGeneration,
  extractCoverTracks,
  normaliseWorkflowName,
  planGeneration,
  readPriorGenerationSpend
} from '../lib/kie/generation.js'

async function tempDir(prefix) {
  return mkdtemp(join(tmpdir(), prefix))
}

async function fixture(dir, name, bytes = 1024) {
  const path = join(dir, name)
  await writeFile(path, Buffer.alloc(bytes, 1))
  return path
}

async function largeSparseFile(dir, name, bytes) {
  const path = join(dir, name)
  const handle = await open(path, 'w')
  await handle.truncate(bytes)
  await handle.close()
  return path
}

test('workflow aliases resolve to the pinned model family', () => {
  assert.equal(normaliseWorkflowName('cover'), 'upload-and-cover')
  assert.equal(normaliseWorkflowName('music'), 'music-generate')
  assert.equal(normaliseWorkflowName('text-to-music'), 'music-generate')
  assert.equal(normaliseWorkflowName('reference-video'), 'reference-to-video')
  assert.equal(normaliseWorkflowName('animate-replace'), 'animate-replace')
  assert.throws(() => normaliseWorkflowName('text-to-video'), /GENERATION_INVALID_PLAN.*unknown workflow/u)
})

test('cover input follows the current Upload And Cover schema', () => {
  const input = buildCoverInput({
    uploadUrl: 'https://provider.example/source.mp3',
    instrumental: false,
    sunoModel: 'V6',
    duration: 60,
    style: 'cinematic hip-hop',
    title: 'Pilot',
    audioWeight: 0.9,
    variety: 0
  })
  assert.equal(input.upload_url, 'https://provider.example/source.mp3')
  assert.equal(input.model, 'V6')
  assert.equal(input.duration, 60)
  assert.equal(input.audio_weight, 0.9)
  assert.equal(input.variety, 0)
  assert.equal(input.image_urls, undefined, 'cover must not send image references')

  assert.throws(
    () => buildCoverInput({ uploadUrl: 'https://x/a.mp3', duration: 9 }),
    /duration must be between 10 and 360/u
  )
  assert.throws(
    () => buildCoverInput({
      uploadUrl: 'https://x/a.mp3',
      duration: 60,
      instrumental: true,
      lyrics: 'not allowed'
    }),
    /lyrics must not be set when instrumental is true/u
  )
  assert.throws(
    () => buildCoverInput({ uploadUrl: 'https://x/a.mp3', duration: 60, audioWeight: 0.555 }),
    /at most two decimal places/u
  )
})

test('music-generate input uses custom mode and enforces instrumental rules', () => {
  const input = buildMusicGenerateInput({
    title: 'Sons of the Red Plains',
    duration: 30,
    sunoModel: 'V6',
    style: 'cinematic African choral epic, Maasai-inspired percussion',
    lyrics: '[Chorus]\nSons of the red plains',
    vocalGender: 'm',
    variety: 0,
    styleWeight: 0.8
  })
  assert.equal(input.custom_mode, true)
  assert.equal(input.instrumental, false)
  assert.equal(input.model, 'V6')
  assert.equal(input.duration, 30)
  assert.equal(input.vocal_gender, 'm')
  assert.equal(input.image_urls, undefined)

  assert.throws(
    () => buildMusicGenerateInput({ title: 'No duration', style: 'epic' }),
    /duration is required/u
  )
  assert.throws(
    () => buildMusicGenerateInput({ title: 'No direction', duration: 30 }),
    /at least one of style, lyrics or negativeTags/u
  )
  assert.throws(
    () => buildMusicGenerateInput({
      title: 'Inst',
      duration: 30,
      style: 'epic drums',
      instrumental: true,
      lyrics: 'not allowed'
    }),
    /lyrics must not be set when instrumental is true/u
  )
})

test('reference-to-video input validates all @ mentions against supplied materials', () => {  const input = buildReferenceVideoInput({
    prompt: 'Keep @video_1 composition and the face from @image_1.',
    videoUrls: ['https://provider.example/ref.mp4'],
    imageUrls: ['https://provider.example/face.png'],
    duration: 6,
    resolution: '1080p',
    aspectRatio: '16:9',
    keepOriginalSound: true
  })
  assert.equal(input.video_urls.length, 1)
  assert.equal(input.image_urls.length, 1)
  assert.equal(input.keep_original_sound, true)
  assert.equal(input.duration, 6)

  assert.throws(
    () => buildReferenceVideoInput({
      prompt: 'Use @video_2',
      videoUrls: ['https://provider.example/ref.mp4']
    }),
    /mentions @video_2.*includes 1 video/u
  )
  assert.throws(
    () => buildReferenceVideoInput({ prompt: 'Use @hero', imageUrls: ['https://x/face.png'] }),
    /does not send elements or voices/u
  )
  assert.throws(
    () => buildReferenceVideoInput({
      prompt: 'Use @video_1',
      videoUrls: ['https://x/ref.mp4'],
      duration: 2
    }),
    /duration must be between 3 and 30/u
  )
})

test('animate-replace input only accepts Wan resolutions and requires both URLs', () => {
  const input = buildAnimateReplaceInput({
    videoUrl: 'https://provider.example/source.mp4',
    imageUrl: 'https://provider.example/face.png',
    resolution: '720p'
  })
  assert.equal(input.resolution, '720p')
  assert.throws(
    () => buildAnimateReplaceInput({
      videoUrl: 'https://x/a.mp4',
      imageUrl: 'https://x/a.png',
      resolution: '1080p'
    }),
    /resolution must be one of 480p, 580p, 720p/u
  )
  assert.throws(
    () => buildAnimateReplaceInput({ videoUrl: 'https://x/a.mp4', resolution: '720p' }),
    /imageUrl is required/u
  )
})

test('planGeneration is free, fail-closed, and rejects mismatched changes', async () => {
  const dir = await tempDir('kie-plan-')
  try {
    const audio = await fixture(dir, 'cue.mp3')
    const plan = await planGeneration({
      workflow: 'cover',
      mode: 'replica',
      maxCredits: 5,
      assets: [{ role: 'audio', path: audio }],
      params: { duration: 60, title: 'Pilot' },
      sourceDurationSeconds: 60
    })
    assert.equal(plan.generationCall, false)
    assert.equal(plan.enabled, false)
    assert.equal(plan.model, 'ai-music-api/upload-and-cover-audio')
    assert.match(plan.request.input.upload_url, /^https:\/\/upload\.invalid\//u)
    assert.equal(plan.request.input.duration, 60)
    assert.ok(plan.warnings.some((warning) => /no price quote/u.test(warning)))

    const musicPlan = await planGeneration({
      workflow: 'music-generate',
      maxCredits: 15,
      totalMaxCredits: 30,
      params: { title: 'Music test', duration: 30, style: 'cinematic percussion' }
    })
    assert.equal(musicPlan.model, 'ai-music-api/generate')
    assert.equal(musicPlan.assets.length, 0)
    assert.equal(musicPlan.request.input.custom_mode, true)
    assert.equal(musicPlan.request.input.duration, 30)

    await assert.rejects(
      planGeneration({ workflow: 'cover', mode: 'transform', maxCredits: 5, assets: [] }),
      /transform mode needs a concrete change/u
    )
    await assert.rejects(
      planGeneration({
        workflow: 'cover',
        mode: 'replica',
        change: 'change anyway',
        maxCredits: 5,
        assets: [{ role: 'audio', path: audio }],
        params: { duration: 60 }
      }),
      /replica mode does not take a change/u
    )
    await assert.rejects(
      planGeneration({
        workflow: 'cover',
        maxCredits: 5,
        assets: [{ role: 'audio', path: audio }],
        params: { duration: 60 },
        sourceDurationSeconds: 481
      }),
      /at most 480s/u
    )
    await assert.rejects(
      planGeneration({ workflow: 'cover', assets: [{ role: 'audio', path: audio }], params: { duration: 60 } }),
      /maxCredits is required/u
    )
    await assert.rejects(
      planGeneration({
        workflow: 'cover',
        maxCredits: 15,
        totalMaxCredits: 14,
        assets: [{ role: 'audio', path: audio }],
        params: { duration: 60 }
      }),
      /totalMaxCredits must be at least maxCredits/u
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('asset preflight enforces roles, exact counts, and Wan upload limits', async () => {
  const dir = await tempDir('kie-assets-')
  try {
    const video = await fixture(dir, 'clip.mp4')
    const image = await fixture(dir, 'face.png')
    const tooBig = await largeSparseFile(dir, 'huge.mp4', 10 * 1024 * 1024 + 1)
    await assert.rejects(
      planGeneration({ workflow: 'animate-replace', maxCredits: 5, assets: [{ role: 'video', path: video }], params: {} }),
      /exactly one video and exactly one image/u
    )
    await assert.rejects(
      planGeneration({
        workflow: 'animate-replace',
        maxCredits: 5,
        assets: [{ role: 'video', path: tooBig }, { role: 'image', path: image }],
        params: {}
      }),
      /Wan animate-replace accepts at most 10 MB/u
    )
    await assert.rejects(
      planGeneration({ workflow: 'cover', maxCredits: 5, assets: [{ role: 'audio', path: video }], params: { duration: 60 } }),
      /audio accepts/u
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('generation gate and budget checks fail closed', () => {
  assert.throws(() => assertGenerationEnabled({ enabled: false, maxCredits: 5 }), /GENERATION_DISABLED/u)
  assert.throws(() => assertGenerationEnabled({ enabled: true }), /maxCredits is required/u)
  assert.throws(
    () => assertBudgetAvailable({ creditsBefore: 2, maxCredits: 5 }),
    /balance 2 is below the task cap 5/u
  )
  assert.deepEqual(evaluateBudget({ spent: 5, maxCredits: 5 }).ok, true)
  assert.equal(evaluateBudget({ spent: 5.1, maxCredits: 5 }).ok, false)
  assert.equal(evaluateBudget({ spent: null, maxCredits: 5 }).ok, null)
})

test('cumulative pilot spending is read from prior result files and enforced', async () => {
  const dir = await tempDir('kie-pilot-budget-')
  try {
    const priorJob = join(dir, 'prior-job')
    await import('node:fs/promises').then(({ mkdir }) => mkdir(priorJob, { recursive: true }))
    await writeFile(join(priorJob, 'generation-result.json'), JSON.stringify({
      credits: { spent: 12 }
    }))
    const prior = await readPriorGenerationSpend(dir)
    assert.equal(prior.spent, 12)
    assert.equal(prior.tasks, 1)
    assert.deepEqual(prior.unknown, [])

    assert.deepEqual(
      assertTotalBudgetAvailable({ priorSpent: prior.spent, totalMaxCredits: 30, maxCredits: 15 }),
      { spent: 12, remaining: 18, totalMaxCredits: 30, maxCredits: 15 }
    )
    assert.throws(
      () => assertTotalBudgetAvailable({ priorSpent: prior.spent, totalMaxCredits: 24, maxCredits: 15 }),
      /12 credits remaining, below the 15 task cap/u
    )
    assert.equal(evaluateTotalBudget({ priorSpent: 12, spent: 15, totalMaxCredits: 30 }).ok, true)
    assert.equal(evaluateTotalBudget({ priorSpent: 12, spent: 19, totalMaxCredits: 30 }).ok, false)

    const unknownJob = join(dir, 'unknown-job')
    await import('node:fs/promises').then(({ mkdir }) => mkdir(unknownJob, { recursive: true }))
    await writeFile(join(unknownJob, 'generation-result.json'), JSON.stringify({ credits: { spent: null } }))
    const unknown = await readPriorGenerationSpend(dir)
    assert.equal(unknown.unknown.length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('cover tracks are extracted across documented response shapes without images', () => {
  const record = {
    raw: {
      response: {
        data: [
          { id: 'a', audio_url: 'https://x/a.mp3', image_url: 'https://x/a.png', title: 'One', duration: 60 },
          { id: 'b', source_audio_url: 'https://x/b.mp3', title: 'Two', duration: 62 },
          { id: 'dup', audio_url: 'https://x/a.mp3', title: 'duplicate', duration: 60 }
        ]
      }
    }
  }
  const tracks = extractCoverTracks(record)
  assert.equal(tracks.length, 2)
  assert.deepEqual(tracks.map((track) => track.url), ['https://x/a.mp3', 'https://x/b.mp3'])
  assert.ok(tracks.every((track) => !track.url.endsWith('.png')))
  assert.equal(collectGeneratedOutputs('upload-and-cover', record)[0].mediaKind, 'audio')
  assert.deepEqual(collectGeneratedOutputs('reference-to-video', { urls: ['https://x/v.mp4'] })[0], {
    url: 'https://x/v.mp4',
    title: null,
    durationSec: null,
    providerId: null,
    mediaKind: 'video'
  })
})

test('mocked executeGeneration archives output and a credential-free ledger row', async () => {
  const dir = await tempDir('kie-run-')
  try {
    const audio = await fixture(dir, 'cue.mp3')
    const outDir = join(dir, 'out')
    let uploads = 0
    let created = null
    let creditsReads = 0
    const result = await executeGeneration({
      enabled: true,
      maxCredits: 5,
      key: 'super-secret-key',
      workflow: 'upload-and-cover',
      mode: 'replica',
      outDir,
      job: 'mock-cover',
      assets: [{ role: 'audio', path: audio }],
      params: { duration: 60, title: 'Pilot' },
      sourceDurationSeconds: 60
    }, {
      getCredits: async () => (++creditsReads === 1 ? 100 : 98),
      uploadFile: async () => {
        uploads += 1
        return { url: 'https://provider.example/uploaded.mp3', bytes: 1024 }
      },
      createTask: async (key, model, input) => {
        created = { key, model, input }
        return 'task_mock_1'
      },
      waitForTask: async () => ({
        state: 'success',
        raw: { creditsConsumed: 2 },
        urls: [],
        response: {
          data: [{ id: 'track-1', audio_url: 'https://provider.example/result.mp3', title: 'Pilot', duration: 60 }]
        }
      }),
      downloadToFile: async (url, path) => {
        await writeFile(path, 'audio output')
        return { path, bytes: 12 }
      },
      appendLedger
    })

    assert.equal(uploads, 1)
    assert.equal(created.key, 'super-secret-key')
    assert.equal(created.model, 'ai-music-api/upload-and-cover-audio')
    assert.equal(created.input.upload_url, 'https://provider.example/uploaded.mp3')
    assert.equal(result.status, 'SUCCESS')
    assert.equal(result.credits.spent, 2)
    assert.equal(result.credits.withinCap, true)
    assert.equal(result.outputs.length, 1)
    assert.equal(await readFile(result.outputs[0].path, 'utf8'), 'audio output')
    assert.match(result.outputs[0].path, /01-pilot\.mp3$/u)

    const planText = await readFile(result.plan, 'utf8')
    const requestText = await readFile(result.request, 'utf8')
    const ledgerText = await readFile(result.ledger, 'utf8')
    assert.ok(!planText.includes('super-secret-key'))
    assert.ok(!requestText.includes('super-secret-key'))
    assert.ok(!ledgerText.includes('super-secret-key'))
    const ledger = JSON.parse(ledgerText.trim())
    assert.equal(ledger.taskId, 'task_mock_1')
    assert.equal(ledger.budgetWithinCap, true)
    assert.equal(ledger.state, 'success')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('execution refuses before upload when disabled or underfunded', async () => {
  const dir = await tempDir('kie-refuse-')
  try {
    const audio = await fixture(dir, 'cue.mp3')
    let uploads = 0
    const base = {
      key: 'secret',
      workflow: 'upload-and-cover',
      assets: [{ role: 'audio', path: audio }],
      params: { duration: 60 },
      outDir: join(dir, 'out'),
      job: 'refuse'
    }
    await assert.rejects(
      executeGeneration({ ...base, enabled: false, maxCredits: 5 }, {
        getCredits: async () => {
          throw new Error('must not be called')
        },
        uploadFile: async () => {
          uploads += 1
        }
      }),
      /GENERATION_DISABLED/u
    )
    await assert.rejects(
      executeGeneration({ ...base, enabled: true, maxCredits: 5 }, {
        getCredits: async () => 2,
        uploadFile: async () => {
          uploads += 1
        }
      }),
      /balance 2 is below the task cap 5/u
    )
    assert.equal(uploads, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an over-cap task is archived and ledgered before it fails loudly', async () => {
  const dir = await tempDir('kie-overcap-')
  try {
    const audio = await fixture(dir, 'cue.mp3')
    let creditsReads = 0
    let captured
    try {
      await executeGeneration({
        enabled: true,
        maxCredits: 5,
        key: 'secret',
        workflow: 'upload-and-cover',
        outDir: join(dir, 'out'),
        job: 'over-cap',
        assets: [{ role: 'audio', path: audio }],
        params: { duration: 60, title: 'Over' }
      }, {
        getCredits: async () => (++creditsReads === 1 ? 100 : 94),
        uploadFile: async () => ({ url: 'https://provider.example/in.mp3', bytes: 1024 }),
        createTask: async () => 'task_over_1',
        waitForTask: async () => ({
          state: 'success',
          raw: { creditsConsumed: 6 },
          response: { data: [{ audio_url: 'https://provider.example/out.mp3', title: 'Over' }] }
        }),
        downloadToFile: async (url, path) => {
          await writeFile(path, 'paid output')
          return { path, bytes: 11 }
        },
        appendLedger
      })
      assert.fail('the over-cap task must fail loudly')
    } catch (error) {
      assert.equal(error.code, 'GENERATION_BUDGET_EXCEEDED')
      captured = error.result
    }
    assert.equal(captured.status, 'SUCCESS_OVER_BUDGET')
    assert.equal(captured.outputs.length, 1)
    assert.equal(await readFile(captured.outputs[0].path, 'utf8'), 'paid output')
    const ledger = JSON.parse((await readFile(captured.ledger, 'utf8')).trim())
    assert.equal(ledger.budgetWithinCap, false)
    assert.equal(ledger.creditsSpent, 6)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a provider-refused task is ledgered with zero spend and no result manifest', async () => {
  const dir = await tempDir('kie-refused-')
  try {
    const audio = await fixture(dir, 'cue.mp3')
    let creditsReads = 0
    await assert.rejects(
      executeGeneration({
        enabled: true,
        maxCredits: 15,
        totalMaxCredits: 30,
        key: 'secret',
        workflow: 'upload-and-cover',
        outDir: join(dir, 'out'),
        job: 'catalog-refusal',
        assets: [{ role: 'audio', path: audio }],
        params: { duration: 60, title: 'Refused' }
      }, {
        getCredits: async () => {
          creditsReads += 1
          return 100
        },
        uploadFile: async () => ({ url: 'https://provider.example/in.mp3', bytes: 1024 }),
        createTask: async () => 'task_refused_1',
        waitForTask: async () => {
          const error = new Error('KIE_TASK_FAILED: task task_refused_1 ended in state fail: This audio matches an existing recording in our catalog.')
          throw error
        },
        appendLedger
      }),
      /matches an existing recording in our catalog/u
    )
    assert.equal(creditsReads, 2, 'credits are read before and after the failed task')
    const jobDir = join(dir, 'out', 'catalog-refusal')
    const ledger = JSON.parse((await readFile(join(jobDir, 'kie-jobs.jsonl'), 'utf8')).trim())
    assert.equal(ledger.state, 'FAILED')
    assert.equal(ledger.creditsSpent, 0)
    assert.equal(ledger.creditsBefore, 100)
    assert.equal(ledger.creditsAfter, 100)
    assert.deepEqual(ledger.outputs, [])
    await assert.rejects(readFile(join(jobDir, 'generation-result.json'), 'utf8'), /ENOENT/u)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
