/**
 * The privacy claim and the live response must be tested together.
 *
 * Measured defect (B3, 2026-11-19): the privacy page said the site "sets no cookies, runs no analytics
 * and has no trackers" while Cloudflare injected static.cloudflareinsights.com/beacon.min.js at the
 * edge. Nothing in the source tree was responsible, so a source-only guard could never have caught it.
 *
 * Worse, the obvious live check is a trap: Cloudflare injects the beacon only when the request sends
 * `Accept: text/html`. A probe without that header sees a clean page and reports a pass. That false
 * PASS actually happened here, minutes before the same URL showed the beacon with the header added.
 *
 * So this file does two jobs:
 *   1. proves the detector still FAILS on a captured response that provably carried the beacon;
 *   2. proves the live probe that uses it sends the load-bearing header and self-tests before it
 *      reports anything, so it cannot silently degrade into the false PASS.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'

const repo = new URL('..', import.meta.url)
const read = (path) => readFile(new URL(path, repo), 'utf8')
const { findForbiddenLoads, loadedThirdPartyHosts } = await import(
  new URL('scripts/live-privacy-probe.mjs', repo).href
)

test('the detector still finds the beacon in a captured response that really carried it', async () => {
  // This is the non-vacuity check for every other guard here. If the beacon can be deleted from this
  // fixture and the rest of the suite stays green, the guard is decoration.
  const fixture = await read('tests/fixtures/cloudflare-beacon-response.html')
  assert.match(fixture, /cloudflareinsights\.com/u, 'the fixture must still contain the captured beacon tag')

  const offenders = findForbiddenLoads(fixture)
  assert.deepEqual(
    offenders,
    ['static.cloudflareinsights.com'],
    'the detector must name the beacon host, and only it, for the captured response',
  )
})

test('the detector does not flag outbound links — a link is not a loaded resource', () => {
  // A guard that cries wolf on <a href="https://github.com"> gets deleted within a week, so prove it
  // is quiet on the one thing these pages legitimately point at.
  const html = `
    <a href="https://github.com/samorachumbi/dsh-media-reader">GitHub</a>
    <a href="https://www.paddle.com/legal/terms">Paddle terms</a>
    <script type="application/json" id="pay-config">{}</script>
    <script>console.log('inline, same origin, not a beacon')</script>
  `
  assert.deepEqual(loadedThirdPartyHosts(html), [], 'an anchor is not a fetched resource')
  assert.deepEqual(findForbiddenLoads(html), [], 'no false positive on outbound links or inline script')
})

test('the deployed source loads no third-party script at all', async () => {
  const files = (await readdir(new URL('store/', repo))).filter((name) => name.endsWith('.html'))
  assert.ok(files.length >= 5, `expected the storefront pages, found: ${files.join(', ')}`)

  for (const file of files) {
    const html = await read(`store/${file}`)
    const remoteScripts = [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["'](https?:)?\/\/[^"']+["']/giu)]
    assert.deepEqual(
      remoteScripts.map((match) => match[0]),
      [],
      `store/${file} must not load any remote script — the privacy page tells visitors there are no trackers`,
    )
    assert.deepEqual(
      findForbiddenLoads(html),
      [],
      `store/${file} must load nothing from a known analytics or tracker host`,
    )
  }
})

test('the live probe sends the load-bearing Accept: text/html header and refuses to fetch without it', async () => {
  const raw = await read('scripts/live-privacy-probe.mjs')
  // Strip comment lines first: a commented-out header is not a sent header. The first version of this
  // guard matched raw source and stayed GREEN when the Accept line was commented out — the same class of
  // false PASS this whole file exists to prevent, reproduced inside the guard itself.
  const source = raw
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|\*|\/\*)/u.test(line))
    .join('\n')

  assert.match(
    source,
    /Accept:\s*'text\/html/u,
    'the probe must send Accept: text/html — without it Cloudflare skips beacon injection and the probe reports a false PASS',
  )
  assert.match(
    source,
    /fetch\([^)]*headers:\s*BROWSER_HEADERS/su,
    'every fetch in the probe must use BROWSER_HEADERS, not the default headers',
  )
  assert.doesNotMatch(
    source,
    /fetch\(\s*url\s*\)/u,
    'a bare fetch(url) would silently drop the Accept header and disable the whole guard',
  )
})

test('the live probe self-tests its detector before it touches the network', async () => {
  const source = await read('scripts/live-privacy-probe.mjs')
  const mainStart = source.indexOf('async function main()')
  assert.ok(mainStart > -1, 'the probe must define main()')
  const mainBody = source.slice(mainStart)

  const selfTestAt = mainBody.indexOf('await selfTest()')
  const firstFetchAt = mainBody.indexOf('fetchPage(')
  assert.ok(selfTestAt > -1, 'main() must run the self-test')
  assert.ok(firstFetchAt > -1, 'main() must fetch pages')
  assert.ok(
    selfTestAt < firstFetchAt,
    'the self-test must run BEFORE the first fetch: a detector that cannot reproduce the defect must never report a pass',
  )
  assert.match(
    source,
    /process\.exit\(2\)/u,
    'the probe must distinguish "could not be trusted" (2) from "found a disagreement" (1)',
  )
})

test('the privacy page still makes the claim the probe enforces', async () => {
  const privacy = await read('store/privacy.html')
  const text = privacy.replace(/<[^>]+>/gu, ' ').replace(/\s+/gu, ' ')

  assert.match(text, /no analytics/iu, 'the policy must state the no-analytics claim')
  assert.match(text, /no trackers/iu, 'the policy must state the no-trackers claim')

  // If the wording is ever softened, the probe's policy assertion must be softened in the same commit
  // — otherwise the two drift and the guard enforces a promise nobody is making any more.
  const probe = await read('scripts/live-privacy-probe.mjs')
  assert.match(probe, /no analytics/iu, 'the probe must check the wording the policy actually uses')
})
