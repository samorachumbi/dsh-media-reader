/**
 * The facts surface — L3 of the LLM-readability plan: "assert the facts page and llms.txt do not contradict each
 * other", and "structured claims are parsed and compared with #pay-config".
 *
 * `store/llms.txt` is the file written for a machine reader, and it now states the commercial terms in prose. Prose
 * is where a second copy of a fact goes to die: it is not generated, so nothing notices when it drifts. So every
 * number and name below is EXTRACTED FROM THE PROSE with a pattern and compared against `#pay-config`, which L2
 * established as the single source. If someone edits either side, this fails and names both values.
 *
 * The cross-checks deliberately run in both directions through every surface that repeats a fact:
 *   #pay-config  ->  llms.txt  ->  Product/Offer JSON-LD  ->  the policy pages
 * so there is no pair that can agree with each other while both being wrong about the source.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const repo = new URL('..', import.meta.url)
const read = (path) => readFile(new URL(path, repo), 'utf8')

const [llms, index, pricing, refund, privacy, terms] = await Promise.all([
  read('store/llms.txt'),
  read('store/index.html'),
  read('store/pricing.html'),
  read('store/refund.html'),
  read('store/privacy.html'),
  read('store/terms.html'),
])

const cfgMatch = /<script type="application\/json" id="pay-config">([\s\S]*?)<\/script>/u.exec(index)
assert.ok(cfgMatch, 'index.html must carry a #pay-config block — it is the source every fact here derives from')
const cfg = JSON.parse(cfgMatch[1])

const product = [...pricing.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gu)]
  .map((m) => JSON.parse(m[1]))
  .find((b) => b['@type'] === 'Product')
assert.ok(product, 'pricing.html must carry a Product — the structured fact surface')

const text = (html) => html.replace(/<[^>]+>/gu, ' ')

/** Pull one number out of llms.txt, failing loudly if the sentence has been rewritten beyond recognition. */
function numberFromLlms(pattern, what) {
  const m = pattern.exec(llms)
  assert.ok(m, `llms.txt must state ${what} — it is the file an agent reads instead of fetching a second page`)
  return Number(m[1].replace(/,/gu, ''))
}

test('llms.txt states the China price, and it is the number #pay-config charges', () => {
  const cny = numberFromLlms(/¥\s*([\d,]+)/u, 'the CNY price')
  assert.equal(cny, cfg.price.cny,
    `llms.txt says ¥${cny} but #pay-config says cny ${cfg.price.cny} — one of them is a price nobody will be charged`)

  const cnyOffer = (product.offers ?? []).find((o) => o.priceCurrency === 'CNY')
  assert.ok(cnyOffer, 'the Product must carry the CNY offer this fact describes')
  assert.equal(Number(cnyOffer.price), cfg.price.cny,
    `the CNY offer ${cnyOffer.price} disagrees with #pay-config cny ${cfg.price.cny}`)
})

test('llms.txt, the Product and the refund page all state the update period in #pay-config', () => {
  const months = numberFromLlms(/(\d+)\s+months of updates/iu, 'the update period')

  assert.ok(cfg.terms, '#pay-config must carry a terms block — otherwise the update period has no single source')
  assert.equal(months, cfg.terms.updatesMonths,
    `llms.txt says ${months} months of updates but #pay-config says ${cfg.terms.updatesMonths}`)

  const prose = `${product.description ?? ''} ${(product.offers ?? []).map((o) => o.description ?? '').join(' ')}`
  assert.match(prose, new RegExp(`${cfg.terms.updatesMonths}\\s+months of updates`, 'iu'),
    `the Product must state ${cfg.terms.updatesMonths} months of updates, the period #pay-config declares`)
})

test('the refund window is one number, read from #pay-config and repeated consistently everywhere', () => {
  assert.ok(cfg.terms, '#pay-config must carry a terms block')
  const declared = cfg.terms.refundDays

  const fromLlms = numberFromLlms(/(\d+)\s+days from purchase/iu, 'the refund window')
  assert.equal(fromLlms, declared, `llms.txt says ${fromLlms} days but #pay-config says ${declared}`)

  const fromRefund = /within\s+(\d+)\s+days/iu.exec(text(refund))
  assert.ok(fromRefund, 'refund.html must state the window in days')
  assert.equal(Number(fromRefund[1]), declared,
    `refund.html says ${fromRefund[1]} days but #pay-config says ${declared}`)

  assert.equal(String(product.hasMerchantReturnPolicy?.merchantReturnDays), String(declared),
    `the Product's structured window ${product.hasMerchantReturnPolicy?.merchantReturnDays} disagrees with #pay-config ${declared}`)

  // The meta description is a claim too, and it is the one a crawler or a search result shows. It is excluded from
  // the check above because that one strips tags, so a window changed only in the description went unnoticed until a
  // mutation probe reintroduced exactly that defect and the suite stayed green.
  const description = /<meta name="description" content="([^"]*)"/u.exec(refund)
  assert.ok(description, 'refund.html must carry a meta description')
  const fromMeta = /within\s+(\d+)\s+days/iu.exec(description[1])
  assert.ok(fromMeta, 'the refund page meta description must state the window — a search result shows this sentence')
  assert.equal(Number(fromMeta[1]), declared,
    `the refund page meta description says ${fromMeta[1]} days but #pay-config says ${declared} — a crawler reads ` +
    'the description, not the prose below it')
})

test('llms.txt and the privacy page name the same merchant of record that #pay-config declares', () => {
  assert.ok(cfg.terms?.merchantOfRecord, '#pay-config must name the merchant of record')
  const declared = cfg.terms.merchantOfRecord

  // No dot in the class: the sentence ends with a full stop, and "Paddle." is not the merchant of record's name.
  const named = /Merchant of record:\**\s*(?:it is\s+)?([A-Z][\w-]*)/u.exec(llms)
  assert.ok(named, 'llms.txt must name the merchant of record — a buyer needs to know who takes the money')
  assert.equal(named[1], declared, `llms.txt names ${named[1]} but #pay-config says ${declared}`)

  assert.match(text(privacy), new RegExp(`processed by ${declared}|${declared} as merchant of record`, 'iu'),
    `the privacy page must name ${declared} as the merchant of record, the party it declares`)

  const paddle = (cfg.methods ?? []).find((m) => m.kind === 'paddle')
  assert.ok(paddle, 'the declared merchant of record must correspond to a configured payment method')
  assert.match(paddle.note, new RegExp(`${declared} is the merchant of record`, 'iu'),
    `the ${declared} rail's own note must state that it is the merchant of record`)
})

test('llms.txt carries the same contact address as the structured seller and the policy pages', () => {
  const fromLlms = /Contact:\**\s*([^\s]+@[^\s]+)/u.exec(llms)
  assert.ok(fromLlms, 'llms.txt must give an agent a contact address')

  const org = [...index.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gu)]
    .map((m) => JSON.parse(m[1]))
    .find((b) => b['@type'] === 'Organization')
  assert.ok(org, 'index.html must carry the seller Organization')
  assert.equal(fromLlms[1], org.email,
    `llms.txt says ${fromLlms[1]} but the Organization says ${org.email}`)

  for (const [name, html] of [['terms', text(terms)], ['privacy', text(privacy)], ['refund', text(refund)]]) {
    assert.ok(html.includes(fromLlms[1]),
      `the ${name} page must carry the same contact address as llms.txt (${fromLlms[1]})`)
  }
})

test('every fact llms.txt claims to have saved a fetch for is actually stated there', () => {
  // The section heading is a promise. These are the facts it promises, named by the words an agent will look for.
  const promised = llms.split('## Facts an agent can rely on')[0]
  for (const [what, pattern] of [
    ['the USD price', /\$79/u],
    ['the shilling indication', /KSh 10,000/u],
    // Re-targeted 2026-11-24: a live Paystack rail now charges KES, so the promised fact reversed. The old
    // wording asserted the opposite, and would have kept passing only by keeping the page wrong.
    ['that shillings are charged on the Kenya rail', /charged in shillings/iu],
    ['what the licence covers', /one team, one time/iu],
    ['the update period', /\d+ months of updates/iu],
    ['the refund window', /\d+ days/iu],
    ['the merchant of record', /merchant of record/iu],
    ['a contact address', /[\w.+-]+@[\w.-]+/u],
  ]) {
    assert.match(promised, pattern, `llms.txt promises the commercial facts but omits ${what}`)
  }
})
