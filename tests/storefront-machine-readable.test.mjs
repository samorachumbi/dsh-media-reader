/**
 * Machine-readable facts — L2 of the discovery-repair plan.
 *
 * These files are static HTML with no build step, so the JSON-LD cannot be generated at deploy time. The
 * duplication is therefore guarded instead: every number in the structured data is asserted against
 * `#pay-config`, which the plan names as the price source of truth, and the refund window is asserted
 * against the refund page's own prose. Change the config without changing the markup and this fails.
 *
 * The two rules that are about *not* claiming things:
 *   - KES must never appear as an Offer. The processor does not charge in shillings, so an Offer naming
 *     shillings would advertise a price nobody can pay. It stays indicative prose.
 *   - No `returnMethod`/`returnFees`: this is software. "Return by mail" is the kind of structured claim
 *     that is worse than silence.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const repo = new URL('..', import.meta.url)
const read = (path) => readFile(new URL(path, repo), 'utf8')

/** file → the canonical URL it must declare (404 is deliberately absent). */
const CANONICAL = {
  'index.html': 'https://store.itikia.co.ke/',
  'pricing.html': 'https://store.itikia.co.ke/pricing',
  'privacy.html': 'https://store.itikia.co.ke/privacy',
  'terms.html': 'https://store.itikia.co.ke/terms',
  'refund.html': 'https://store.itikia.co.ke/refund',
}

function payConfig(html) {
  const match = /<script type="application\/json" id="pay-config">([\s\S]*?)<\/script>/u.exec(html)
  assert.ok(match !== null, 'index.html must carry a #pay-config JSON block')
  return JSON.parse(match[1])
}

/** Every JSON-LD block on a page, parsed. */
function jsonLd(html) {
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gu)]
  return blocks.map((m) => {
    try {
      return JSON.parse(m[1])
    } catch (error) {
      assert.fail(`a JSON-LD block does not parse: ${error.message}`)
    }
  })
}

const offersIn = (blocks) => blocks.flatMap((b) => (Array.isArray(b.offers) ? b.offers : []))

test('every crawlable page declares one absolute canonical matching its own URL, and 404 declares none', async () => {
  for (const [file, expected] of Object.entries(CANONICAL)) {
    const html = await read(`store/${file}`)
    const found = [...html.matchAll(/<link rel="canonical" href="([^"]+)"/gu)].map((m) => m[1])
    assert.equal(found.length, 1, `store/${file} must declare exactly one canonical, found ${found.length}`)
    assert.equal(found[0], expected, `store/${file} canonical must be ${expected}`)
    assert.match(found[0], /^https:\/\/store\.itikia\.co\.ke\//u, 'a canonical must be absolute, not relative')
  }

  // A canonical on a 404 tells crawlers the error page is the real page.
  const notFound = await read('store/404.html')
  assert.doesNotMatch(notFound, /rel="canonical"/u, 'the 404 page must not declare a canonical')
})

test('the Pricing structured data is derived from #pay-config, not typed independently', async () => {
  const [cfgHtml, pricing] = await Promise.all([read('store/index.html'), read('store/pricing.html')])
  const cfg = payConfig(cfgHtml)
  const offers = offersIn(jsonLd(pricing))

  assert.ok(offers.length >= 2, `pricing.html must carry at least a USD and a CNY offer, found ${offers.length}`)

  const usd = offers.find((o) => o.priceCurrency === 'USD')
  const cny = offers.find((o) => o.priceCurrency === 'CNY')
  assert.ok(usd, 'a USD offer is required — USD is what the processor charges')
  assert.ok(cny, 'a CNY offer is required — China is a charged market')

  assert.equal(Number(usd.price), cfg.price.usd,
    `USD offer ${usd.price} disagrees with #pay-config price.usd ${cfg.price.usd}`)
  assert.ok(Number.isInteger(cfg.price.cny),
    '#pay-config must now state the CNY price as a number, so this guard can derive it')
  assert.equal(Number(cny.price), cfg.price.cny,
    `CNY offer ${cny.price} disagrees with #pay-config price.cny ${cfg.price.cny}`)

  for (const offer of offers) {
    assert.equal(offer.availability, 'https://schema.org/InStock',
      `offer ${offer.priceCurrency} must state availability explicitly`)
    assert.ok(offer.url?.startsWith('https://store.itikia.co.ke/'),
      `offer ${offer.priceCurrency} must point at the storefront`)
    assert.ok(offer.seller?.name, `offer ${offer.priceCurrency} must name the seller`)
  }
})

test('no Offer advertises a currency the processor cannot charge', async () => {
  for (const file of Object.keys(CANONICAL)) {
    const offers = offersIn(jsonLd(await read(`store/${file}`)))
    for (const offer of offers) {
      assert.notEqual(offer.priceCurrency, 'KES',
        `${file} must not publish a KES offer — shillings are indicative prose, not a chargeable price`)
      assert.notEqual(Number(offer.price), 10000,
        `${file} must not publish the indicative shilling figure as an offer price`)
      assert.ok(!/shilling/i.test(String(offer.description ?? '')),
        `${file}: an Offer description must not call a price shillings`)
    }
  }
})

test('the Product states what the licence covers: one team, one time, 12 months of updates', async () => {
  const cfg = payConfig(await read('store/index.html'))
  const product = jsonLd(await read('store/pricing.html')).find((b) => b['@type'] === 'Product')
  assert.ok(product, 'pricing.html must carry a Product')

  const prose = `${product.description ?? ''} ${offersIn([product]).map((o) => o.description ?? '').join(' ')}`
  // Derive the unit wording from #pay-config rather than restating it here.
  for (const word of String(cfg.price.unit).split(/[,\s]+/u).filter((w) => w.length > 3)) {
    assert.match(prose, new RegExp(word, 'iu'),
      `the Product must repeat the #pay-config unit wording "${word}" so an agent can read the commercial shape`)
  }
  assert.match(prose, /12 months of updates/iu,
    'the Product must state the 12-month update period, or a buyer cannot tell what they are getting')
  assert.ok(product.license?.startsWith('https://store.itikia.co.ke/'),
    'the Product must link the licence terms')
  // A licence URL that points at a page nobody publishes is worse than none: it is a broken promise an agent follows.
  const slug = product.license.replace(/^https:\/\/store\.itikia\.co\.ke\/?/u, '') || 'index'
  // A missing page must fail as a stated claim, not as an unhandled ENOENT — the mutation probe requires a guard to
  // name the defect, and "no such file" names nothing.
  const licencePage = await read(`store/${slug}.html`).catch(() => {
    assert.fail(`the Product links ${product.license}, but store/${slug}.html does not exist`)
  })
  assert.match(licencePage.replace(/<[^>]+>/gu, ' '), /licen[cs]e/iu,
    `the Product links ${product.license}, so that page must actually be about the licence`)
})

test('the seller is machine-readable on the homepage: legal name, storefront URL and contact', async () => {
  const html = await read('store/index.html')
  const org = jsonLd(html).find((b) => b['@type'] === 'Organization')
  assert.ok(org, 'index.html must carry an Organization for the seller')
  // Compared against the policy pages rather than a literal: the seller's legal name is a fact those pages state, and
  // a copy in this file would drift from them without anything noticing.
  assert.ok(org.legalName, 'the Organization must state the seller legal name')
  for (const page of ['terms', 'privacy', 'refund']) {
    const prose = (await read(`store/${page}.html`)).replace(/<[^>]+>/gu, ' ')
    assert.ok(prose.includes(org.legalName),
      `the ${page} page must name the seller ${org.legalName}, the legal name the Organization publishes`)
  }
  assert.equal(org.url, 'https://store.itikia.co.ke', 'the Organization URL must be the storefront')
  assert.equal(org.email, 'hello@itikia.co.ke',
    'the machine-readable contact must be the canonical published address, not the issuer personal address')
  assert.equal(org.address?.addressCountry, 'KE', 'the seller address country must be stated')
})

test('the refund window is machine-readable and equals the refund page own number', async () => {
  const refund = await read('store/refund.html')
  const stated = /within\s+(\d+)\s+days/iu.exec(refund.replace(/<[^>]+>/gu, ' '))
  assert.ok(stated, 'refund.html must state the refund window in days')

  const product = jsonLd(await read('store/pricing.html')).find((b) => b['@type'] === 'Product')
  const policy = product?.hasMerchantReturnPolicy
  assert.ok(policy, 'the Product must carry a MerchantReturnPolicy so an agent can read the refund terms')
  assert.equal(String(policy.merchantReturnDays), stated[1],
    `the structured refund window ${policy.merchantReturnDays} disagrees with the refund page's ${stated[1]} days`)
  assert.equal(policy.returnPolicyCategory, 'https://schema.org/MerchantReturnFiniteReturnWindow',
    'a finite window must be declared as such')
  assert.equal(policy.url, 'https://store.itikia.co.ke/refund', 'the policy must point at the refund page')
})

test('the file count and the "each with a sha256" claim are derived from the shipped bundle', async () => {
  // The storefront tells a buyer a countable fact about a real artifact. This reads that artifact.
  const { readdir, stat } = await import('node:fs/promises')
  const { createHash } = await import('node:crypto')
  const bundleRoot = new URL('dist-tools/bundle/', repo)
  const dirs = (await readdir(bundleRoot, { withFileTypes: true })).filter((d) => d.isDirectory())
  const manifests = []
  for (const d of dirs) {
    const candidate = new URL(`${d.name}/MANIFEST.json`, bundleRoot)
    if (await stat(candidate).then(() => true, () => false)) manifests.push([d.name, candidate])
  }
  assert.equal(manifests.length, 1, `expected exactly one shipped bundle, found ${manifests.length}`)

  const [name, manifestUrl] = manifests[0]
  const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'))
  const files = manifest.files
  assert.equal(manifest.file_count, files.length,
    `MANIFEST file_count ${manifest.file_count} disagrees with its own ${files.length} entries`)

  // "each with a sha256 you can check" — so check every one.
  const base = new URL(`${name}/`, bundleRoot)
  const bad = []
  for (const entry of files) {
    assert.match(String(entry.sha256), /^[a-f0-9]{64}$/u, `${entry.path} must carry a sha256`)
    const actual = createHash('sha256').update(await readFile(new URL(entry.path, base))).digest('hex')
    if (actual !== entry.sha256) bad.push(entry.path)
  }
  assert.deepEqual(bad, [], `these bundle files do not match their manifest hash: ${bad.join(', ')}`)

  // And the pages must state that same number rather than a remembered one.
  const claim = `${files.length} files`
  const storefront = await read('store/index.html')
  assert.match(storefront, new RegExp(`<b>${claim}</b>`, 'u'),
    `the sales page must claim ${claim} — the artifact it ships has ${files.length}`)
  const storeReadme = await read('store/README.md')
  assert.match(storeReadme, new RegExp(`\\|\\s*${claim}\\b`, 'u'),
    `store/README.md must claim ${claim} to match the shipped manifest`)
})
