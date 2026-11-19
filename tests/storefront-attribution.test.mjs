/**
 * Purchase attribution — which channel produced a sale, recorded when money moves.
 *
 * The measured problem this replaces: the storefront had a tagged commercial link in the README and in
 * `llms.txt`, but nothing connected a completed order back to the link that produced it. The only ways
 * to find out were a pageview tracker — which the published privacy policy forbids, and which
 * ad-blockers would undercount anyway — or asking buyers afterwards.
 *
 * The mechanism that avoids both: the campaign tags ride on the transaction itself as Paddle
 * `customData`, so the sale carries its own provenance. No cookie, no storage, no beacon, nothing to
 * consent to.
 *
 * These tests evaluate the SHIPPED source block out of `store/index.html` rather than a copy of its
 * logic. A re-implementation here would stay green while the page did something else.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const repo = new URL('..', import.meta.url)
const read = (path) => readFile(new URL(path, repo), 'utf8')

const BEGIN = 'purchase attribution:begin'
const END = 'purchase attribution:end'

async function attributionFor(search) {
  const html = await read('store/index.html')
  assert.equal(html.split(BEGIN).length - 1, 1, 'the begin marker must appear exactly once')
  assert.equal(html.split(END).length - 1, 1, 'the end marker must appear exactly once')
  const from = html.indexOf(BEGIN)
  const to = html.indexOf(END)
  assert.ok(from > -1 && to > from, 'index.html must keep the marked attribution block')

  const block = html.slice(html.indexOf('\n', from), html.lastIndexOf('\n', to))
  const factory = new Function('location', `${block}\nreturn { attribution, attrClean };`)
  return factory({ search })
}

test('a tagged link records the channel it arrived on', async () => {
  const { attribution } = await attributionFor('?utm_source=github&utm_medium=repo&utm_campaign=discovery_repair')
  assert.deepEqual(attribution(), {
    utm_source: 'github',
    utm_medium: 'repo',
    utm_campaign: 'discovery_repair',
  })
})

test('an untagged purchase is classified as direct instead of going unmeasured', async () => {
  for (const search of ['', '?', '?utm_source=&utm_medium=']) {
    const { attribution } = await attributionFor(search)
    assert.deepEqual(attribution(), { utm_source: 'direct' },
      `"${search || '(no query)'}" must still classify the sale as direct rather than leaving it blank`)
  }
})

test('hostile or oversized tags are sanitised, not forwarded to Paddle', async () => {
  const nasty = `?utm_source=${encodeURIComponent('<script>alert(1)</script>')}&utm_campaign=${'x'.repeat(200)}`
  const { attribution } = await attributionFor(nasty)
  const tags = attribution()

  assert.match(tags.utm_source, /^[a-z0-9_.-]+$/u, 'only the safe character class may survive into the order')
  assert.ok(!tags.utm_source.includes('<'), 'no angle bracket may reach the transaction')
  assert.ok(tags.utm_source.length <= 40, `utm_source must be capped at 40, got ${tags.utm_source.length}`)
  assert.equal(tags.utm_campaign.length, 60, 'utm_campaign must be capped at 60, not truncated by the provider')
})

test('the checkout sends the tags, and collects them without a cookie or any storage', async () => {
  const html = await read('store/index.html')

  assert.match(html, /customData: withAttribution\(\{/u,
    'attribution must be merged into the same customData payload the order already carries')
  assert.match(html, /licensee_entity: entity\.value\.trim\(\)/u,
    'the licensee entity must still ride on that payload — attribution must not displace it')

  for (const page of ['index.html', 'privacy.html', 'pricing.html', 'terms.html', 'refund.html', '404.html']) {
    const source = await read(`store/${page}`)
    assert.doesNotMatch(source, /document\.cookie/u, `${page} must not set or read a cookie`)
  }

  const from = html.indexOf(BEGIN)
  const to = html.indexOf(END)
  // Strip comments before asserting: the block's own comment says "no localStorage", so matching raw
  // text would flag the promise itself as the violation. This is the identical mistake that let the
  // Accept-header guard stay green on commented-out code earlier the same evening.
  const blockCode = html.slice(from, to)
    .split('\n')
    .filter((line) => !/^\s*\/\//u.test(line))
    .join('\n')
  assert.doesNotMatch(blockCode, /\b(?:localStorage|sessionStorage|indexedDB)\b/u,
    'attribution must persist nothing in the browser — the URL is the only carrier')
})

test('the privacy policy discloses the channel record the storefront now makes', async () => {
  const privacy = await read('store/privacy.html')

  assert.match(privacy, /which channel a sale came from/iu, 'the policy must disclose purchase attribution')
  assert.match(privacy, /no cookie, no local\s+storage, no tracking script/iu,
    'it must state how the tags are collected, so the claim can be checked')
  assert.match(privacy, /Network Error Logging/iu,
    'the policy must name NEL — it is visible in the response headers, and a reader can check')
  assert.match(privacy, /Last updated 2026-11-19/u, 'the date must move whenever the policy changes')
})

test('the Worker re-sanitises the tags, stores them, and shows the channel to the operator', async () => {
  const worker = await read('worker/licence/src/index.js')

  assert.match(worker, /function readAttribution\(/u,
    'the Worker must sanitise the tags again rather than trusting the browser')
  assert.match(worker, /const attribution = readAttribution\(custom\)/u,
    'the tags must be read from the transaction custom data, not from anything else the request sent')
  assert.match(worker, /attribution,/u, 'attribution must be stored on the licence record')
  assert.match(worker, /'Channel', channelLine\(readAttribution\(custom\)\)/u,
    'the operator alert must name the channel, or the record is never read')
  assert.match(worker, /utm_source = 'unknown'/u,
    'an order carrying no tags must read as unknown, not as a blank that looks like a bug')
})
