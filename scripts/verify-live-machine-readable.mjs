#!/usr/bin/env node
/**
 * verify-live-machine-readable.mjs — L3: "fetch the built pages through the real deployment whitelist and parse what
 * a reader receives"; "parse the JSON-LD as JSON, not with string greps".
 *
 * The unit tests read files from git. This reads the SITE. Those are different claims: a file can be correct and
 * still never be deployed (`store/robots.txt` was exactly that until it was added to the deploy whitelist), and an
 * edge can serve something the repository does not contain (Cloudflare's robots.txt — the shape of defect B3).
 *
 *   node scripts/verify-live-machine-readable.mjs                     # against store/DEPLOYED-URL
 *   node scripts/verify-live-machine-readable.mjs --base https://...  # against any deployment
 *   node scripts/verify-live-machine-readable.mjs --self-test         # no network: serve store/ locally and prove
 *                                                                     # BOTH directions — a clean copy passes, a
 *                                                                     # copy with a broken price fails
 *
 * Exit: 0 every check passed · 1 at least one check failed · 2 the site could not be reached, so nothing was verified.
 * A check that cannot run is reported as SKIP with its reason, never as a pass.
 */
import { cp, mkdtemp, readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join, extname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const STORE = join(REPO, 'store')

const argv = process.argv.slice(2)
const has = (name) => argv.includes(name)
const valueOf = (name) => {
  const index = argv.indexOf(name)
  return index === -1 ? null : argv[index + 1] ?? null
}

const PAGES = [
  ['/', 'index.html'],
  ['/pricing', 'pricing.html'],
  ['/privacy', 'privacy.html'],
  ['/terms', 'terms.html'],
  ['/refund', 'refund.html'],
]

const results = []
let failures = 0
let skips = 0

async function check(name, fn) {
  try {
    results.push({ ok: true, name, detail: await fn() })
  } catch (error) {
    failures++
    results.push({ ok: false, name, detail: error.message })
  }
}

function skip(name, reason) {
  skips++
  results.push({ ok: null, name, detail: `SKIP — ${reason}` })
}

const fail = (message) => {
  throw new Error(message)
}

/** Every JSON-LD block on a page, parsed as JSON. A block that does not parse is a failure, not a warning. */
function jsonLdOf(html, where) {
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gu)]
  return blocks.map((match, index) => {
    try {
      return JSON.parse(match[1])
    } catch (error) {
      fail(`${where}: JSON-LD block ${index + 1} does not parse as JSON — ${error.message}`)
    }
  })
}

function payConfigOf(html, where) {
  const match = /<script type="application\/json" id="pay-config">([\s\S]*?)<\/script>/u.exec(html)
  if (!match) fail(`${where}: the served page carries no #pay-config block, so no fact can be checked against it`)
  try {
    return JSON.parse(match[1])
  } catch (error) {
    fail(`${where}: #pay-config does not parse as JSON — ${error.message}`)
  }
}

/**
 * @param get async (path) -> { status, ok, body } — one shape for every check, so no check can accidentally read a
 *            Response stream twice or mistake a status for a body.
 */
async function runChecks(get) {
  const home = await get('/')
  if (!home.ok) fail(`/ returned HTTP ${home.status} — the storefront itself is not being served`)
  const cfg = payConfigOf(home.body, '/')

  await check('the live #pay-config parses and declares the commercial terms', () => {
    if (!cfg.price?.usd) fail('/: #pay-config has no price.usd')
    if (!cfg.terms?.refundDays) fail('/: #pay-config has no terms block, so the live facts have no single source')
    return `usd ${cfg.price.usd} · cny ${cfg.price.cny} · ${cfg.terms.updatesMonths} months of updates · ` +
      `${cfg.terms.refundDays}-day refund · merchant of record ${cfg.terms.merchantOfRecord}`
  })

  for (const [path] of PAGES) {
    await check(`${path} is served with parseable JSON-LD and exactly one absolute canonical`, async () => {
      const page = path === '/' ? home : await get(path)
      if (page.status !== 200) fail(`${path}: HTTP ${page.status}`)
      const blocks = jsonLdOf(page.body, path)
      const canonicals = [...page.body.matchAll(/<link rel="canonical" href="([^"]+)"/gu)].map((m) => m[1])
      if (canonicals.length !== 1) fail(`${path}: expected exactly one canonical, the served page has ${canonicals.length}`)
      if (!/^https:\/\//u.test(canonicals[0])) fail(`${path}: canonical ${canonicals[0]} is not absolute`)
      return `${canonicals[0]} · ${blocks.length} JSON-LD block(s)`
    })
  }

  await check('the live Product offers agree with the live #pay-config price', async () => {
    const page = await get('/pricing')
    const product = jsonLdOf(page.body, '/pricing').find((block) => block['@type'] === 'Product')
    if (!product) fail('/pricing: no Product — the structured price claim is missing from the live site')
    const offers = product.offers ?? []
    const usd = offers.find((offer) => offer.priceCurrency === 'USD')
    const cny = offers.find((offer) => offer.priceCurrency === 'CNY')
    if (!usd) fail('/pricing: no live USD offer')
    if (!cny) fail('/pricing: no live CNY offer')
    if (Number(usd.price) !== cfg.price.usd) {
      fail(`/pricing: live USD offer ${usd.price} disagrees with the live #pay-config ${cfg.price.usd} — the site ` +
        'contradicts itself')
    }
    if (Number(cny.price) !== cfg.price.cny) fail(`/pricing: live CNY offer ${cny.price} disagrees with #pay-config ${cfg.price.cny}`)
    if (offers.some((offer) => offer.priceCurrency === 'KES')) {
      fail('/pricing: a live KES offer advertises a price the processor cannot charge')
    }
    const days = String(product.hasMerchantReturnPolicy?.merchantReturnDays)
    if (days !== String(cfg.terms.refundDays)) {
      fail(`/pricing: live return window ${days} disagrees with the live #pay-config ${cfg.terms.refundDays}`)
    }
    return `USD ${usd.price} · CNY ${cny.price} · ${days}-day window, each agreeing with the live #pay-config`
  })

  await check('the live llms.txt states the same facts as the live page', async () => {
    const page = await get('/llms.txt')
    if (page.status !== 200) fail(`/llms.txt: HTTP ${page.status}`)
    const llms = page.body
    if (!/^# dsh-media-reader/mu.test(llms)) fail('/llms.txt: not the dsh-media-reader facts file')
    const cny = /¥\s*([\d,]+)/u.exec(llms)
    if (!cny) fail('/llms.txt: no CNY price')
    if (Number(cny[1].replace(/,/gu, '')) !== cfg.price.cny) {
      fail(`/llms.txt says ¥${cny[1]} but the live #pay-config says ${cfg.price.cny}`)
    }
    const months = /(\d+)\s+months of updates/iu.exec(llms)
    if (!months) fail('/llms.txt: no update period')
    if (Number(months[1]) !== cfg.terms.updatesMonths) {
      fail(`/llms.txt says ${months[1]} months but the live #pay-config says ${cfg.terms.updatesMonths}`)
    }
    const days = /(\d+)\s+days from purchase/iu.exec(llms)
    if (!days) fail('/llms.txt: no refund window')
    if (Number(days[1]) !== cfg.terms.refundDays) {
      fail(`/llms.txt says ${days[1]} days but the live #pay-config says ${cfg.terms.refundDays}`)
    }
    if (!new RegExp(cfg.terms.merchantOfRecord, 'iu').test(llms)) {
      fail(`/llms.txt never names ${cfg.terms.merchantOfRecord}, the merchant of record the live page declares`)
    }
    return `¥${cny[1]} · ${months[1]} months · ${days[1]} days · ${cfg.terms.merchantOfRecord} — all agree`
  })

  await check('the served robots.txt is OURS, not the Cloudflare edge file', async () => {
    // The question L4 exists to answer. Cloudflare serves its own robots.txt for this zone, and ours only wins if the
    // deployed file replaces it. The edge file is comment-only with zero rules, so that is what identifies it.
    const page = await get('/robots.txt')
    if (page.status !== 200) fail(`/robots.txt: HTTP ${page.status} — nothing is served at that path`)
    if (!/^\s*User-agent:\s*\*/imu.test(page.body)) {
      fail(`/robots.txt: no "User-agent: *" rule. This is Cloudflare's comment-only edge file, so our deployed ` +
        `robots.txt did NOT replace it (${Buffer.byteLength(page.body, 'utf8')} bytes, every content line a comment)`)
    }
    if (!/^\s*Allow:\s*\//imu.test(page.body)) fail('/robots.txt: the served file must allow crawling')
    // Buffer.byteLength, not .length: string length counts UTF-16 code units, so any em dash in the file makes the
    // reported size smaller than the file. Measuring a fetched body by its character count is the same class of
    // mistake as reading curl's compressed transfer size as the file size.
    return `${Buffer.byteLength(page.body, 'utf8')} bytes with User-agent: * and Allow: / — our file is being served`
  })

  await check('an unknown path returns a real 404 that declares no canonical', async () => {
    const page = await get('/this-path-does-not-exist')
    if (page.status !== 404) fail(`an unknown path returned HTTP ${page.status}, not 404`)
    if (/rel="canonical"/u.test(page.body)) {
      fail('the 404 page declares a canonical, which tells a crawler the error page is the real page')
    }
    return 'unknown path → 404, no canonical'
  })
}

function report(title, list) {
  console.log(`\n== ${title}`)
  for (const item of list) {
    console.log(`  ${item.ok === true ? 'PASS' : item.ok === false ? 'FAIL' : 'SKIP'}  ${item.name}`)
    if (item.detail) console.log(`        ${item.detail}`)
  }
}

function reset() {
  failures = 0
  skips = 0
  results.length = 0
}

/** A client over node:http, for the self-test. Same {status, ok, body} shape as the fetch client. */
function localClient(base) {
  return async (path) => {
    const response = await fetch(new URL(path, base), { redirect: 'manual' })
    return { status: response.status, ok: response.ok, body: await response.text() }
  }
}

/** Minimal static server over a directory: `/` → index.html, and `<name>` → `<name>` or `<name>.html`. */
async function serveDirectory(dir) {
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname
    const bare = path.slice(1)
    const candidates = bare === ''
      ? ['index.html']
      : [bare, `${bare}.html`, extname(bare) ? null : `${bare}.html`].filter(Boolean)
    for (const candidate of candidates) {
      try {
        const body = await readFile(join(dir, candidate))
        response.writeHead(200, { 'content-type': extname(candidate) === '.html' ? 'text/html' : 'text/plain' })
        return response.end(body)
      } catch { /* next candidate */ }
    }
    try {
      const body = await readFile(join(dir, '404.html'))
      response.writeHead(404, { 'content-type': 'text/html' })
      return response.end(body)
    } catch {
      response.writeHead(404)
      return response.end('not found')
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, base: `http://127.0.0.1:${server.address().port}/` }
}

async function selfTest() {
  const dir = await mkdtemp(join(tmpdir(), 'store-selftest-'))
  await cp(STORE, dir, { recursive: true })
  const { server, base } = await serveDirectory(dir)
  const get = localClient(base)
  const finish = async (code) => {
    server.close()
    return code
  }

  // Direction 1: the real store must pass. A verifier that fails the good copy is as useless as one that passes a bad copy.
  reset()
  await runChecks(get)
  const cleanResults = results.slice()
  const cleanFailures = failures
  report('SELF-TEST 1 — the clean store (must pass)', cleanResults)

  // Direction 2: a copy whose #pay-config disagrees with its own markup must fail, and the Product-versus-config
  // check must be the one that names it. If this direction passes, the verifier proves nothing.
  const indexPath = join(dir, 'index.html')
  const original = await readFile(indexPath, 'utf8')
  const broken = original.replace(/"usd":\s*79/u, '"usd": 89')
  if (broken === original) {
    await finish()
    fail('self-test could not break #pay-config — the anchor no longer matches the page')
  }
  await (await import('node:fs/promises')).writeFile(indexPath, broken)

  reset()
  await runChecks(get)
  const brokenResults = results.slice()
  const brokenFailures = failures
  const named = brokenResults.filter((item) => item.ok === false).map((item) => item.name)
  report('SELF-TEST 2 — #pay-config broken (usd 79 → 89) must fail', brokenResults)

  console.log('')
  await finish()
  if (cleanFailures !== 0) return fail(`self-test FAILED: the clean store should pass and had ${cleanFailures} failure(s)`)
  if (brokenFailures === 0) return fail('self-test FAILED: a broken price was not detected — this verifier proves nothing')
  if (!named.some((name) => /Product offers agree/i.test(name))) {
    return fail(`self-test FAILED: the broken price was caught by [${named.join(' | ')}] but not by the ` +
      'Product-versus-#pay-config check, which is the one that must name a disagreement')
  }
  console.log(`self-test PASSED — clean store: 0 failures · broken copy: ${brokenFailures} failure(s), including ` +
    'the Product-versus-#pay-config disagreement')
  return 0
}

async function main() {
  if (has('--self-test')) return selfTest()

  const base = valueOf('--base') ?? (await readFile(join(STORE, 'DEPLOYED-URL'), 'utf8')).trim()
  const get = async (path) => {
    let response
    try {
      response = await fetch(new URL(path, base), { redirect: 'manual', headers: { accept: 'text/html,text/plain' } })
    } catch (error) {
      console.error(`could not reach ${new URL(path, base)} — ${error.message}`)
      console.error('exit 2: the site was unreachable, so NOTHING was verified')
      process.exit(2)
    }
    return { status: response.status, ok: response.ok, body: await response.text() }
  }

  console.log(`verifying the machine-readable surface of ${base}`)
  await runChecks(get)
  report(base, results)
  console.log('')
  if (failures > 0) {
    console.log(`${failures} check(s) FAILED, ${skips} skipped`)
    return 1
  }
  console.log(`all checks passed, ${skips} skipped`)
  return 0
}

process.exitCode = (await main().catch((error) => {
  console.error(error.message ?? error)
  return 1
})) ?? 0
