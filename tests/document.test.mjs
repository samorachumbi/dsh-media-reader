/**
 * Document reading — the class of file the composer cannot attach at all.
 *
 * The composer accepts exactly four image MIME types and answers everything else with "Only PNG, JPG, WebP,
 * and GIF images are supported". So a PDF invoice, a signed licence, a CSV export or a Markdown note cannot
 * reach an agent through the UI. These tests pin the behaviour that makes them readable — and, more
 * importantly, pin the two ways a reader like this lies: reporting an empty string for a scan, and reporting
 * a truncated body as if it were the whole document.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DOCUMENT_EXTENSIONS,
  documentEnvelope,
  documentFormat,
  isSupportedDocumentPath,
  readDocument
} from '../lib/documents.js'

const ctx = { get: () => undefined } // no subprocess service; every PDF test injects runImpl
const dir = await mkdtemp(join(tmpdir(), 'doc-test-'))
const write = async (name, body) => {
  const path = join(dir, name)
  await writeFile(path, body)
  return path
}

test('the document set covers the files a buyer actually receives', () => {
  for (const extension of ['.pdf', '.md', '.txt', '.csv', '.json', '.yaml', '.html', '.srt']) {
    assert.ok(DOCUMENT_EXTENSIONS.has(extension), `${extension} must be readable as a document`)
  }
  assert.equal(isSupportedDocumentPath('licence.md'), true)
  assert.equal(isSupportedDocumentPath('LICENCE.PDF'), true, 'extension matching is case-insensitive')
  assert.equal(isSupportedDocumentPath('photo.png'), false, 'images are not documents — they keep their own path')
  assert.equal(isSupportedDocumentPath('clip.mp4'), false)
})

test('formats are named so the reader can branch without guessing', () => {
  assert.equal(documentFormat('a.pdf'), 'pdf')
  assert.equal(documentFormat('a.markdown'), 'markdown')
  assert.equal(documentFormat('a.csv'), 'csv')
  assert.equal(documentFormat('a.yml'), 'yaml')
  assert.equal(documentFormat('a.vtt'), 'subtitle')
  assert.equal(documentFormat('a.txt'), 'text')
})

test('a markdown licence is read as text, with its size and character count stated', async () => {
  const body = '# Licence\n\nIssued to ACME Ltd.\n'
  const result = await readDocument(ctx, { path: await write('licence.md', body) })
  assert.equal(result.format, 'markdown')
  assert.equal(result.unreadable, false)
  assert.match(result.text, /Issued to ACME Ltd/u)
  const envelope = documentEnvelope('licence.md', result)
  assert.match(envelope, /^\[document: licence\.md\]/u, 'the block must name the file the way the media tools do')
  assert.match(envelope, /<type>document-text<\/type>/u)
  assert.match(envelope, /<extractedChars>\d+<\/extractedChars>/u)
  assert.match(envelope, /<truncated>false<\/truncated>/u)
})

test('truncation is stated, never silent', async () => {
  const long = 'x'.repeat(5000)
  const result = await readDocument(ctx, { path: await write('long.txt', long) })
  const envelope = documentEnvelope('long.txt', result, { maxChars: 1000 })
  assert.match(envelope, /<truncated>true<\/truncated>/u)
  assert.match(envelope, /<extractedChars>5000<\/extractedChars>/u, 'the real length is still reported')
  assert.match(envelope, /Only the first 1000 characters/u, 'the reader is told what it is missing')
  assert.ok(envelope.length < long.length, 'the body is actually cut')
})

test('a scanned PDF reports no-text-layer instead of an empty document', async () => {
  // pdftotext exits 0 with empty output for an image-only PDF. Returning "" would read as "this file is
  // empty" and the agent would summarise nothing with total confidence.
  const path = await write('scan.pdf', '%PDF-1.7\n%fake\n')
  const result = await readDocument(ctx, {
    path,
    runImpl: async (argv) => (argv[0] === 'pdfinfo'
      ? { stdout: 'Pages:          2\n', stderr: '', exitCode: 0, timedOut: false }
      : { stdout: '   \n\n', stderr: '', exitCode: 0, timedOut: false })
  })
  assert.equal(result.unreadable, true)
  assert.equal(result.reason, 'no-text-layer')
  assert.equal(result.pages, 2)
  const envelope = documentEnvelope('scan.pdf', result)
  assert.match(envelope, /<type>document-unreadable<\/type>/u)
  assert.match(envelope, /<reason>no-text-layer<\/reason>/u)
  assert.match(envelope, /pdftoppm/u, 'the guidance must name the route that would work')
  assert.doesNotMatch(envelope, /<content>/u, 'no content block may be emitted for a document that was not read')
})

test('a real PDF text layer becomes text, with its page count', async () => {
  const path = await write('invoice.pdf', '%PDF-1.7\n%fake\n')
  const result = await readDocument(ctx, {
    path,
    runImpl: async (argv) => (argv[0] === 'pdfinfo'
      ? { stdout: 'Pages:          3\n', stderr: '', exitCode: 0, timedOut: false }
      : { stdout: 'INVOICE 0042\nTotal: KES 10,000\n', stderr: '', exitCode: 0, timedOut: false })
  })
  assert.equal(result.unreadable, false)
  assert.equal(result.pages, 3)
  assert.match(result.text, /KES 10,000/u)
  const envelope = documentEnvelope('invoice.pdf', result)
  assert.match(envelope, /<format>pdf<\/format>/u)
  assert.match(envelope, /<pages>3<\/pages>/u)
})

test('a missing extractor is a missing tool, not an empty document', async () => {
  const path = await write('nopoppler.pdf', '%PDF-1.7\n%fake\n')
  await assert.rejects(
    readDocument(ctx, { path, runImpl: async () => ({ stdout: '', stderr: 'spawn pdftotext ENOENT', exitCode: 127, timedOut: false }) }),
    (error) => error.code === 'MISSING_TOOL' && /poppler-utils/u.test(error.message)
  )
})

test('csv and json state their shape, which is what makes them useful to an agent', async () => {
  const csv = await readDocument(ctx, { path: await write('rows.csv', 'name,team,seats\nAda,Acme,4\nBo,Beta,2\n') })
  const csvEnvelope = documentEnvelope('rows.csv', csv)
  assert.match(csvEnvelope, /<rows>3<\/rows>/u)
  assert.match(csvEnvelope, /<columns>3<\/columns>/u)

  const json = await readDocument(ctx, { path: await write('order.json', '{"entity":"Acme","amount":1000000}') })
  const jsonEnvelope = documentEnvelope('order.json', json)
  assert.match(jsonEnvelope, /<json>object<\/json>/u)
  assert.match(jsonEnvelope, /<content>/u)
})

test('html is read as its text, not as markup soup', async () => {
  const html = await readDocument(ctx, {
    path: await write('page.html', '<html><style>p{color:red}</style><p>Hello <b>world</b></p><script>x()</script></html>')
  })
  assert.match(html.text, /Hello\s+world/u)
  assert.doesNotMatch(html.text, /color:red|function|x\(\)/u)
  assert.equal(html.derivedFrom, 'html-markup', 'the reader must know the text was derived from markup')
})

test('an empty or binary file says so rather than returning nothing', async () => {
  await assert.rejects(readDocument(ctx, { path: await write('empty.txt', '') }), (e) => e.code === 'EMPTY_FILE')
  const binary = await readDocument(ctx, { path: await write('weird.txt', Buffer.from([0x00, 0x01, 0x02, 0x03])) })
  assert.equal(binary.unreadable, true, 'binary bytes with a text extension are not silently passed off as text')
})

test('utf-16 and BOM files decode instead of turning into mojibake', async () => {
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Itikia licence', 'utf16le')])
  const result = await readDocument(ctx, { path: await write('u16.txt', utf16) })
  assert.equal(result.encoding, 'utf-16le')
  assert.match(result.text, /Itikia licence/u)
})

test.after(async () => { await rm(dir, { recursive: true, force: true }) })

/* ── the client half: the drop must never reach the composer's image-only refusal ─────────────── */

const clientSource = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')

test('the client half claims document drops, so the composer never refuses them', () => {
  // The harness accepts four image types and answers everything else with "Only PNG, JPG, WebP, and GIF
  // images are supported". A document therefore has to be taken out of its hands rather than argued with.
  assert.match(clientSource, /DOCUMENT_EXTENSION\s*=/u, 'the client must know the document extensions')
  // Read the alternation out of the constant rather than pattern-matching the raw source: the entries are
  // regex fragments (`ya?ml`, `html?`), so a literal-string match would be wrong in both directions.
  const line = clientSource.split('\n').find((candidate) => candidate.includes('DOCUMENT_EXTENSION ='))
  assert.ok(line !== undefined, 'DOCUMENT_EXTENSION must be declared')
  const entries = line.slice(line.indexOf('(') + 1, line.indexOf(')$')).split('|')
  for (const fragment of ['pdf', 'md', 'csv', 'json', 'ya?ml', 'html?', 'srt', 'vtt']) {
    assert.ok(entries.includes(fragment), `"${fragment}" must be a claimed document type (got: ${entries.join(' ')})`)
  }
  assert.match(clientSource, /if \(list\.some\(isDocumentFile\)\) event\.stopPropagation\(\)/u,
    'a document drop must stop propagation before the composer sees it')
  assert.match(clientSource, /accept: 'image\/\*,audio\/\*,video\/\*,\.pdf/u,
    'the file picker must offer documents too, or the picker is a second dead end')
  assert.match(clientSource, /isHandledFile/u, 'media and documents must share one "handled" predicate')
})

test('media keeps flowing to the harness: documents are claimed, nothing else is swallowed', () => {
  // The regression this prevents already happened once: swallowing every drop stopped the composer
  // accepting attachments at all. Only a document may be claimed outright.
  assert.doesNotMatch(clientSource, /if \(list\.some\(isMediaFile\)\) event\.stopPropagation\(\)/u,
    'media must NOT be claimed — the harness attaches a real image block itself')
})

/* ── the tool wiring: a document must be read from a real filesystem path ────────────────────── */

test('media_document reads the resolved process path, not the fs descriptor', async () => {
  // This is the bug a live session found and no unit test did: `resolved.target` is a descriptor object, so
  // stat() on it fails with '"[object Object]" does not exist' and the model sees an error instead of a
  // document. The guard executes the real tool against a real file, so the wiring is covered, not just the
  // reader.
  const { apply } = await import('../lib/index.js')
  const register = new Map()
  const fsStub = {
    resolve: async (requestedPath) => ({ targetKey: requestedPath, displayPath: requestedPath }),
    stat: async () => ({ type: 'file', size: 8 }),
    processPath: (target) => target.targetKey,
    readBytes: async () => Buffer.from('x')
  }
  const ctx = {
    fs: fsStub,
    tools: { register: (tool) => { register.set(tool.name, tool) } },
    get: () => undefined,
    effect: () => {},
    on: () => {}
  }
  apply(ctx, {})

  const tool = register.get('media_document')
  assert.ok(tool !== undefined, 'media_document must be registered')

  const licence = '# Licence\n\nIssued to ACME Ltd under sha256 6bf9255b.\n'
  const path = await write('wired.md', licence)
  const exec = { signal: undefined, agent: { session: { header: { cwd: dir } } } }
  const out = await tool.execute({ path }, exec)
  assert.match(out, /<type>document-text<\/type>/u)
  assert.match(out, /Issued to ACME Ltd/u, 'the tool must read the real file through the resolved path')
  assert.doesNotMatch(out, /object Object/u, 'the descriptor object must never reach stat()')
})

test('media_document refuses a media path and names the right tool', async () => {
  const { apply } = await import('../lib/index.js')
  const register = new Map()
  const fsStub = {
    resolve: async (p) => ({ targetKey: p, displayPath: p }),
    stat: async () => ({ type: 'file', size: 8 }),
    processPath: (t) => t.targetKey
  }
  apply({
    fs: fsStub,
    tools: { register: (t) => register.set(t.name, t) },
    get: () => undefined,
    effect: () => {},
    on: () => {}
  }, {})
  const tool = register.get('media_document')
  await assert.rejects(
    tool.execute({ path: 'photo.png' }, { signal: undefined, agent: { session: { header: { cwd: dir } } } }),
    (error) => /not a supported document extension/u.test(String(error?.message ?? error))
  )
})
