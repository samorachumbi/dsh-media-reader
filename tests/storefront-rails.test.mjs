/**
 * Storefront rails and policy pages — the rules that let a payment processor review this store.
 *
 * Two failure modes are being prevented, both of which have already happened once in this project:
 *   1. a page that shows a buy button for a rail that cannot take money (`#pay-config` with a blank
 *      url, or a Paddle rail missing its price id or client token);
 *   2. a page that claims something the product does not deliver — "M-Pesa and cards accepted" while
 *      no rail was live, or a PayPal promise that only ever existed in a README.
 *
 * Paddle also requires, before it will verify an account: publicly reachable Terms, Privacy and
 * Refund pages, a contact email on the homepage, and prices that match the catalog.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'

const repo = new URL('..', import.meta.url)
const read = (name) => readFile(new URL(`store/${name}`, repo), 'utf8')

function payConfig(html) {
  const match = /<script type="application\/json" id="pay-config">([\s\S]*?)<\/script>/u.exec(html)
  assert.ok(match !== null, 'index.html must carry a #pay-config JSON block')
  return JSON.parse(match[1])
}

test('every payment rail is either a configured link or a configured Paddle overlay', async () => {
  const cfg = payConfig(await read('index.html'))
  assert.ok(Array.isArray(cfg.methods) && cfg.methods.length > 0, 'at least one rail must be declared')

  for (const method of cfg.methods) {
    for (const field of ['id', 'label', 'note']) {
      assert.equal(typeof method[field], 'string', `rail ${method.id ?? '(no id)'} needs a ${field}`)
      assert.ok(method[field].length > 0, `rail ${method.id} has an empty ${field}`)
    }
    assert.ok(['paddle', 'link'].includes(method.kind), `rail ${method.id} has unknown kind ${method.kind}`)
    // The fields each kind needs before it may render. A half-configured rail must render nothing.
    const required = method.kind === 'paddle' ? ['priceId', 'clientToken'] : ['url']
    for (const field of required) {
      assert.ok(field in method, `rail ${method.id} (${method.kind}) must declare "${field}" so the gate can test it`)
    }
    assert.ok('verified' in method, `rail ${method.id} must declare "verified"`)
  }

  // The gating itself must exist in the script: a rail without a verified date never renders.
  const html = await read('index.html')
  assert.match(html, /function isLive\(m\)/u, 'the live-rail gate must exist')
  assert.match(html, /if \(!m \|\| !m\.verified\) return false/u, 'the gate must reject an unverified rail')
  assert.match(html, /m\.kind === 'paddle'\) return Boolean\(m\.priceId && m\.clientToken\)/u,
    'the Paddle rail must require both a price id and a client token')
})

test('a rail renders only when it carries a recorded verification date', async () => {
  const cfg = payConfig(await read('index.html'))
  const html = await read('index.html')

  // Flipped deliberately 2026-11-16: the Paddle rail has now taken a real checkout (transaction
  // txn_01m78ay7kgjnyhs7nc9j356q9z, invoice 55704-10001), so it is allowed to render. What must NOT
  // survive is a rail claiming a verification it does not have.
  for (const m of cfg.methods) {
    if (!m.verified) continue
    assert.match(m.verified, /^\d{4}-\d{2}-\d{2}$/u, `rail ${m.id} has a verified value that is not an ISO date`)
    const t = Date.parse(`${m.verified}T00:00:00Z`)
    assert.ok(Number.isFinite(t), `rail ${m.id} has an unparseable verified date`)
    assert.ok(t <= Date.now(), `rail ${m.id} claims verification on ${m.verified}, a date that has not arrived`)
  }

  // Only the rail whose checkout actually completed may render. Paystack has never seen a payment,
  // and its empty `verified` is the single field keeping it dark.
  const live = cfg.methods.filter((m) => m.verified && (m.kind === 'paddle' ? m.priceId && m.clientToken : m.url))
  assert.deepEqual(live.map((m) => m.id), ['paddle'], 'only a rail with a completed checkout may render a button')
  const unverified = cfg.methods.find((m) => m.id === 'paystack')
  assert.ok(unverified, 'the Paystack rail must still be declared')
  assert.equal(unverified.verified, '', 'the Paystack rail must not claim a verification it does not have')

  // And the dead-end branch must still exist for the case where nothing is verified.
  assert.match(html, /Checkout is not open yet/u, 'the page needs a dead-end branch for a rail with no verification')
})

test('the page never promises a rail we dropped', async () => {
  const html = await read('index.html')
  assert.doesNotMatch(html, /flutterwave/iu, 'Flutterwave was dropped by the operator and must not appear')
  assert.doesNotMatch(html, /M-Pesa and cards accepted/iu, 'the old false footer claim must not return')

  // PayPal is legitimate — Paddle offers it — but only inside a rail's label/note, never as our own claim.
  const mentions = [...html.matchAll(/paypal/giu)].length
  const cfg = payConfig(html)
  const railText = cfg.methods.map((m) => `${m.label} ${m.note}`).join(' ')
  const inRail = [...railText.matchAll(/paypal/giu)].length
  assert.equal(mentions, inRail, 'PayPal may only be mentioned as a Paddle payment method')
})

test('the advertised price is a currency Paddle can actually charge', async () => {
  const cfg = payConfig(await read('index.html'))
  assert.equal(cfg.price.usd, 79, 'the catalog price is USD 79')
  assert.equal(cfg.price.chargedIn, 'USD', 'the page must state which currency is charged')
  assert.equal(cfg.price.kesIndicative, true, 'KES must be marked indicative: it is not a Paddle currency')
  const html = await read('index.html')
  assert.match(html, /Charged in USD/u, 'the buy area must say the charge is in USD')
})

test('Paddle-required policy pages exist, are linked, and name the contact address', async () => {
  const html = await read('index.html')
  // Paddle's wording is "clearly accessible through site navigation", so the link must be in the
  // NAV — not merely somewhere in the page. A footer link alone did not trip this test when it was
  // written, which is exactly the kind of passing-but-toothless assertion this file exists to avoid.
  const nav = /<nav class="site"[\s\S]*?<\/nav>/u.exec(html)
  assert.ok(nav !== null, 'the page must have a site nav')
  for (const page of ['terms.html', 'privacy.html', 'refund.html']) {
    await stat(new URL(`store/${page}`, repo))          // exists
    assert.match(nav[0], new RegExp(`href="${page}"`, 'u'), `${page} must be linked in the site nav`)
    assert.match(html, new RegExp(`href="${page}"`, 'u'), `${page} must also be linked from the footer`)
    const body = await read(page)
    assert.match(body, /hello@itikia\.co\.ke/u, `${page} must carry the contact address`)
    assert.match(body, /Itikia Digital Solutions/u, `${page} must name the seller`)
  }
  // Paddle requires a contact route reachable from the homepage itself.
  const hero = html.slice(0, html.indexOf('<footer'))
  assert.match(html, /mailto:hello@itikia\.co\.ke/u, 'the homepage must offer a contact email')
  assert.ok(hero.length > 0)
})

test('the refund page states the window the operator chose', async () => {
  const body = await read('refund.html')
  assert.match(body, /14 days/u, 'the refund window is 14 days')
  assert.match(body, /statutory rights/iu, 'the policy must acknowledge statutory rights, which Paddle enforces')
  assert.match(body, /Paddle is the <strong>merchant of record<\/strong>/u, 'refunds are issued through Paddle')
})

test('the delivery promise is the one the fulfilment process can keep', async () => {
  // The Terms said "normally immediate once payment is confirmed" while the FAQ said "within one business
  // day" — and the fulfilment is `tools/issue-licence.py`, run by a human after the sale. Only one of those
  // sentences was true. A delivery promise is a refund exposure, not marketing: make it match the mechanism
  // and keep the two pages from drifting apart again.
  const terms = await read('terms.html')
  const home = await read('index.html')
  assert.doesNotMatch(terms, /normally immediate/iu, 'the Terms must not promise immediate delivery')
  assert.match(terms, /within one business day/u, 'the Terms must state the real delivery window')
  assert.match(home, /within one business day/u, 'the homepage FAQ must state the same window')
  assert.match(terms, /emailed to the address you paid with/u, 'delivery is by email to the payer')
})

test('an unknown path returns a real 404 page, not the homepage with a 200', async () => {
  // Cloudflare Pages served index.html for every unmatched path until a 404.html existed, so a typo'd or
  // guessed URL looked like a valid page. A reviewer following a broken link should see "not found".
  const page = await read('404.html')
  assert.match(page, /404/u, 'the page must say it is a 404')
  assert.match(page, /noindex/u, 'a 404 page must not be indexed')
  for (const target of ['/', 'terms.html', 'privacy.html', 'refund.html']) {
    assert.match(page, new RegExp(`href="${target.replace('/', '\\/')}"`, 'u'), `404 page must link to ${target}`)
  }
  const script = (await import('node:fs/promises')).readFile(new URL('tools/deploy-store.sh', repo), 'utf8')
  assert.match(await script, /WHITELIST=\(.*404\.html.*\)/u, '404.html must be deployed, or it has no effect')
})

test('a pricing page exists, states the catalogue price, and is reachable from the nav', async () => {
  // Paddle's verification form asks for "a link to your pricing page" and refuses the domain root. The review
  // also compares the page against the catalogue, so the numbers here must be the numbers Paddle charges.
  const page = await read('pricing.html')
  assert.match(page, /\$79/u, 'the price must be stated')
  assert.match(page, /per team, one time/u, 'the unit must be stated')
  assert.match(page, /¥560/u, 'the CNY price must match the Paddle price (56000 fen)')
  assert.match(page, /14 days/u, 'the refund window must match the refund policy')
  assert.match(page, /merchant of record/u, 'it must say who processes payment')
  assert.match(page, /Checkout is open/u, 'now that a checkout has completed, the page must say checkout is open')
  assert.doesNotMatch(page, /opens shortly|coming soon/iu, 'a closed-checkout promise must not survive checkout going live')
  // The claim the page is allowed to make is bounded: a completed checkout on this domain, not a customer.
  assert.doesNotMatch(page, /customers|trusted by|thousands/iu, 'no traction claim may be made from one $0.00 test order')

  const home = await read('index.html')
  const nav = /<nav class="site"[\s\S]*?<\/nav>/u.exec(home)
  assert.match(nav[0], /href="pricing.html"/u, 'the pricing page must be linked in the site nav')
  const script = await (await import('node:fs/promises')).readFile(new URL('tools/deploy-store.sh', repo), 'utf8')
  assert.match(script, /WHITELIST=\(.*pricing\.html.*\)/u, 'pricing.html must be deployed')
})

test('a Paddle transaction link opens its checkout even while the buy button is gated', async () => {
  // Paddle appends ?_ptxn=<transaction id> to the account's default payment link, and Paddle.js opens
  // the checkout for that transaction itself once it is initialized. Every Paddle transaction link —
  // the checkout link on an invoice, and the founder verification checkout — arrives this way.
  //
  // The defect this catches was live on 2026-11-12: the script returned early on the "no live rail"
  // branch BEFORE anything read the parameter, so a real, discounted, ready-to-pay transaction link
  // landed on a page that silently did nothing. Reading _ptxn is not the same as having a live rail:
  // a transaction keyed to an existing transaction can only collect that transaction's total, so
  // honouring the link must NOT be gated on `verified`.
  const html = await read('index.html')

  const handlerAt = html.indexOf("URLSearchParams(location.search).get('_ptxn')")
  assert.ok(handlerAt > -1, 'the page must read the _ptxn parameter Paddle appends to the default payment link')

  const earlyReturnAt = html.indexOf('if (live.length === 0)')
  assert.ok(earlyReturnAt > -1, 'the gated dead-end branch must still exist')
  assert.ok(handlerAt < earlyReturnAt,
    'the _ptxn handler must run BEFORE the "checkout is not open" early return, or a transaction link does nothing')

  assert.match(html, /loadPaddle\(function \(\) \{\s*window\.Paddle\.Initialize\(\{ token: paddleRail\.clientToken \}\);/u,
    'the handler must initialize Paddle.js from the Paddle rail client token so it can open the transaction checkout')
  assert.match(html, /new URLSearchParams\(location\.search\)/u,
    'the parameter must be read from the query string, not assumed')
})
