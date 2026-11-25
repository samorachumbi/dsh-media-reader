/**
 * Document reading — PDFs and text files, for the class of file the harness cannot attach.
 *
 * Why this exists: the DSH composer accepts exactly four image MIME types (png, jpeg, webp, gif) and refuses
 * everything else with "Only PNG, JPG, WebP, and GIF images are supported". A PDF invoice, a signed licence, a
 * CSV export or a Markdown note therefore cannot be handed to an agent at all — even though the text inside
 * them is exactly what a language model is good at. This module closes that gap at the file level, without
 * pretending the file was an image.
 *
 * Rules this file owns:
 * - never fabricate: a PDF with no text layer (a scan) returns `document-unreadable` and says why, and points
 *   at the raster route (`pdftoppm` → `media_image`) instead of inventing content;
 * - argv arrays only, no shell, through the same bounded runner the media tools use;
 * - explicit truncation: long documents are cut at a stated character count and flagged `<truncated>true</truncated>`;
 * - a missing extractor is reported as a missing tool with the install hint, never as an empty document.
 */
import { readFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import { MediaError } from './errors.js'
import { runProcess } from './exec.js'

export const DOCUMENT_EXTENSIONS = new Set([
  '.pdf',
  '.md', '.markdown', '.txt', '.text', '.log', '.rst',
  '.csv', '.tsv', '.json', '.jsonl', '.yaml', '.yml',
  '.html', '.htm', '.xml', '.srt', '.vtt'
])

const TEXT_EXTENSIONS = new Set([...DOCUMENT_EXTENSIONS].filter((extension) => extension !== '.pdf'))
const MAX_FILE_BYTES = 64 * 1024 * 1024
const MAX_TEXT_CHARS = 60_000
const PDF_TIMEOUT_MS = 120_000

export function isSupportedDocumentPath(filePath) {
  return DOCUMENT_EXTENSIONS.has(extname(String(filePath)).toLowerCase())
}

export function documentFormat(filePath) {
  const extension = extname(String(filePath)).toLowerCase()
  if (extension === '.pdf') return 'pdf'
  if (extension === '.md' || extension === '.markdown') return 'markdown'
  if (extension === '.csv' || extension === '.tsv') return 'csv'
  if (extension === '.json' || extension === '.jsonl') return 'json'
  if (extension === '.yaml' || extension === '.yml') return 'yaml'
  if (extension === '.html' || extension === '.htm') return 'html'
  if (extension === '.xml') return 'xml'
  if (extension === '.srt' || extension === '.vtt') return 'subtitle'
  return 'text'
}

/** Decode the common encodings without a dependency. UTF-8 first; a BOM or invalid sequence falls back. */
function decode(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { text: buffer.subarray(2).toString('utf16le'), encoding: 'utf-16le' }
  }
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { text: buffer.subarray(3).toString('utf8'), encoding: 'utf-8-bom' }
  }
  const asUtf8 = buffer.toString('utf8')
  if (asUtf8.includes('\uFFFD')) return { text: buffer.toString('latin1'), encoding: 'latin1' }
  return { text: asUtf8, encoding: 'utf-8' }
}

/** Readable text from HTML/XML: drop script and style bodies, then tags, then collapse whitespace. */
function textFromMarkup(markup) {
  return markup
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/giu, ' ')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/&nbsp;/giu, ' ')
    .replace(/&amp;/giu, '&')
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/[ \t]+/gu, ' ')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
}

/** Structure that is cheap to state and useful to an agent: how big, how many rows/keys, what shape. */
function describeStructure(format, text) {
  if (format === 'csv') {
    const lines = text.split('\n').filter((line) => line.trim().length > 0)
    const delimiter = text.includes('\t') ? '\t' : ','
    const columns = (lines[0] ?? '').split(delimiter).length
    return { rows: lines.length, columns }
  }
  if (format === 'json') {
    try {
      const value = JSON.parse(text)
      if (Array.isArray(value)) return { jsonType: 'array', items: value.length }
      if (value !== null && typeof value === 'object') return { jsonType: 'object', keys: Object.keys(value).length }
      return { jsonType: typeof value }
    } catch {
      // Invalid JSON is still readable text; saying so is more useful than throwing.
      return { jsonType: 'unparseable' }
    }
  }
  return {}
}

async function readPdf(ctx, { path, signal, runImpl }) {
  const run = runImpl ?? ((argv, options) => runProcess(ctx, argv, options))
  const text = await run(['pdftotext', '-layout', '-enc', 'UTF-8', path, '-'], {
    timeoutMs: PDF_TIMEOUT_MS,
    signal,
    maxOutputBytes: 8 * 1024 * 1024
  })

  if (text.timedOut) throw new MediaError('TIMEOUT', 'pdftotext did not finish within two minutes')
  if (text.exitCode === null || text.exitCode === 127 || /not found|No such file/iu.test(text.stderr)) {
    throw new MediaError(
      'MISSING_TOOL',
      'pdftotext is not installed, so PDF text cannot be extracted. Install poppler-utils ' +
      '(Debian/Ubuntu: sudo apt install poppler-utils) and retry. The file itself is fine.'
    )
  }
  if (text.exitCode !== 0) {
    throw new MediaError('PDF_UNREADABLE', `pdftotext failed: ${String(text.stderr).trim().slice(0, 300)}`)
  }

  let pages
  try {
    const info = await run(['pdfinfo', path], { timeoutMs: 30_000, signal, maxOutputBytes: 64 * 1024 })
    const match = /^Pages:\s+(\d+)/mu.exec(info.stdout)
    if (match !== null) pages = Number(match[1])
  } catch {
    // pdfinfo is optional; the page count is a convenience, never a claim about content.
  }

  return { text: text.stdout, pages }
}

/**
 * Read one document. Returns the extracted text plus what is known about it, or throws a MediaError naming
 * exactly why it could not be read.
 */
export async function readDocument(ctx, { path, signal, maxChars = MAX_TEXT_CHARS, runImpl }) {
  const info = await stat(path).catch(() => null)
  if (info === null) throw new MediaError('NOT_FOUND', `"${path}" does not exist`)
  if (!info.isFile()) throw new MediaError('NOT_A_FILE', `"${path}" is not a regular file`)
  if (info.size > MAX_FILE_BYTES) {
    throw new MediaError('FILE_TOO_LARGE', `the file is ${info.size} bytes; the limit is ${Math.round(MAX_FILE_BYTES / (1024 * 1024))} MB`)
  }
  if (info.size === 0) throw new MediaError('EMPTY_FILE', 'the file is empty')

  const format = documentFormat(path)

  if (format === 'pdf') {
    const { text, pages } = await readPdf(ctx, { path, signal, runImpl })
    const trimmed = text.replace(/\r\n/gu, '\n').trim()
    if (trimmed.length === 0) {
      // A scan, or a PDF whose text is only in images. Say that; never summarise an empty string.
      return {
        format,
        pages,
        text: '',
        unreadable: true,
        reason: 'no-text-layer',
        sizeBytes: info.size,
        guidance:
          'This PDF carries no text layer — it is almost certainly a scan or an export of images. Nothing is ' +
          'invented here. To read it, render the pages first (pdftoppm -r 200 -png <file> /tmp/page) and call ' +
          'media_image on the resulting PNGs; on a vision route they are read directly, on a text-only route ' +
          'the configured vision route describes them.'
      }
    }
    return { format, pages, text: trimmed, sizeBytes: info.size, unreadable: false }
  }

  const buffer = await readFile(path)
  const { text: raw, encoding } = decode(buffer)
  const normalised = raw.replace(/\r\n/gu, '\n').replace(/\r/gu, '\n')
  const isMarkup = format === 'html' || format === 'xml'
  const body = isMarkup ? textFromMarkup(normalised) : normalised
  const trimmed = body.trim()
  if (trimmed.length === 0) {
    return {
      format,
      text: '',
      unreadable: true,
      reason: 'no-text',
      sizeBytes: info.size,
      encoding,
      guidance: 'The file contained no text after decoding — it may be binary with a misleading extension.'
    }
  }
  // A NUL byte, or a high share of non-printable characters, means this is a binary file wearing a text
  // extension. Decoding it "successfully" into control characters and calling that a document is the same
  // failure as summarising an empty scan: plausible, useless, and invisible.
  const sample = trimmed.slice(0, 4096)
  const nonPrintable = [...sample].filter((character) => {
    const code = character.codePointAt(0)
    return code === 0 || (code < 32 && character !== '\n' && character !== '\r' && character !== '\t')
  }).length
  if (sample.includes('\u0000') || nonPrintable / sample.length > 0.1) {
    return {
      format,
      text: '',
      unreadable: true,
      reason: 'binary-content',
      sizeBytes: info.size,
      encoding,
      guidance:
        'The bytes are binary despite the extension, so no text was extracted. If this is a document in an ' +
        'unusual format, convert it first; if it is media, call media_probe to identify it.'
    }
  }
  return {
    format,
    text: trimmed,
    sizeBytes: info.size,
    encoding,
    derivedFrom: isMarkup ? `${format}-markup` : undefined,
    ...describeStructure(format, trimmed),
    unreadable: false
  }
}

/** The block inserted into the composer draft, shaped like the media tools' output. */
export function documentEnvelope(displayPath, result, { maxChars = MAX_TEXT_CHARS } = {}) {
  const lines = [`[document: ${displayPath}]`, `<path>${displayPath}</path>`]
  if (result.unreadable === true) {
    lines.push('<type>document-unreadable</type>', `<format>${result.format}</format>`)
    if (result.pages !== undefined) lines.push(`<pages>${result.pages}</pages>`)
    lines.push(`<sizeBytes>${result.sizeBytes}</sizeBytes>`, `<reason>${result.reason}</reason>`)
    lines.push(`<guidance>${result.guidance}</guidance>`)
    return lines.join('\n')
  }

  const body = result.text.length > maxChars ? result.text.slice(0, maxChars) : result.text
  const truncated = body.length < result.text.length
  lines.push('<type>document-text</type>', `<format>${result.format}</format>`, `<sizeBytes>${result.sizeBytes}</sizeBytes>`)
  if (result.pages !== undefined) lines.push(`<pages>${result.pages}</pages>`)
  if (result.encoding !== undefined) lines.push(`<encoding>${result.encoding}</encoding>`)
  if (result.derivedFrom !== undefined) lines.push(`<derivedFrom>${result.derivedFrom}</derivedFrom>`)
  if (result.rows !== undefined) lines.push(`<rows>${result.rows}</rows>`)
  if (result.columns !== undefined) lines.push(`<columns>${result.columns}</columns>`)
  if (result.jsonType !== undefined) lines.push(`<json>${result.jsonType}</json>`)
  lines.push(`<extractedChars>${result.text.length}</extractedChars>`)
  lines.push(`<truncated>${truncated}</truncated>`)
  if (truncated) {
    lines.push(`<note>Only the first ${maxChars} characters are included. Ask for a page range or a section to read the rest.</note>`)
  }
  lines.push('<content>', body, '</content>')
  return lines.join('\n')
}
