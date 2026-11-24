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
    // 'paystack' added 2026-11-24: a rail whose checkout our own Worker starts, rather than a hosted link
    // or the Paddle overlay. It still needs a url (the init endpoint) before it may render.
    assert.ok(['paddle', 'link', 'paystack'].includes(method.kind),
      `rail ${method.id} has unknown kind ${method.kind}`)
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

  // Both rails have now taken a real live payment, so both may render. What must NOT survive is a rail
  // claiming a verification it does not have — so each date is tied to the event that produced it.
  const live = cfg.methods.filter((m) => m.verified && (m.kind === 'paddle' ? m.priceId && m.clientToken : m.url))
  assert.deepEqual(live.map((m) => m.id).sort(), ['paddle', 'paystack'],
    'both rails have taken a real live payment and may render; an unverified third rail must not appear')

  const paystack = cfg.methods.find((m) => m.id === 'paystack')
  assert.ok(paystack, 'the Paystack rail must be declared')
  // The date is the day the first live KSh 10,000 cleared (reference dsh_b4f7d503…, Paystack txn
  // 6796301894, licence issued 1.9 s later). A rail may not claim a date earlier than that.
  assert.equal(paystack.verified, '2026-11-24', 'the Paystack rail verifies against the first real payment, not a guess')
  assert.match(paystack.url, /^https:\/\/dsh-licence\.itikia\.workers\.dev\/paystack\/init$/u,
    'the Kenya rail starts its checkout at our own Worker, which is what makes fulfilment automatic')

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

test('chargeability is derived from the rails, and the prose agrees with it in both states', async () => {
  const cfg = payConfig(await read('index.html'))
  assert.equal(cfg.price.usd, 79, 'the catalog price is USD 79')

  // Chargeability is DERIVED, not asserted once at the top. The fields this test used to require
  // (chargedIn: 'USD', kesIndicative: true) encoded "shillings can never be charged" — a premise that expired
  // when a Kenyan processor was configured, and one the paystack rail's own note contradicted all along.
  for (const method of cfg.methods) {
    assert.ok(['USD', 'KES', 'CNY'].includes(method.charges),
      `${method.id} must declare the currency it charges in, got ${JSON.stringify(method.charges)}`)
  }
  const live = (m) => Boolean(m.verified) &&
    (m.kind === 'paddle' ? Boolean(m.priceId && m.clientToken) : Boolean(m.url))
  const chargeable = cfg.methods.filter(live).map((m) => m.charges)
  assert.ok(chargeable.length > 0, 'at least one rail must be live, or the page cannot take an order at all')

  // The hedge is what keeps the page honest while the Kenya rail is dark. It must be present when no live rail
  // charges KES and MUST disappear the moment one does, so opening a rail cannot leave a stale caveat behind.
  const kesLive = chargeable.includes('KES')
  // Whitespace-tolerant on purpose: llms.txt and pricing.html wrap this sentence across lines, and a literal
  // pattern fails on the wrap while the wording is perfectly correct (the same trap as a journal anchor).
  // Tolerant at EVERY gap, not just one: llms.txt wraps after "charges", pricing.html wraps after "rail".
  const hedge = /no\s+rail\s+charges\s+shillings\s+today/iu
  for (const name of ['index.html', 'llms.txt', 'pricing.html']) {
    const text = await read(name)
    if (kesLive) {
      assert.doesNotMatch(text, hedge,
        `${name} still says no rail charges shillings, but ${chargeable.join('/')} is live and KES is chargeable`)
    } else {
      assert.match(text, hedge,
        `${name} must say shillings are not charged yet — no live rail charges KES (live: ${chargeable.join('/') || 'none'})`)
    }
  }
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

test('the checkout asks who the licence is issued to, and Paddle never receives an address from the page', async () => {
  // Found on the first real order, 2026-11-16: Paddle issued an invoice and the customer record held
  // only an email (`name: null`) — it collects an address, never a company. A licence that names a
  // mailbox is not a team licence, so the storefront has to ask for the entity.
  //
  // The address is the opposite case. The first build also asked for a "email for delivery", which
  // put TWO addresses on one transaction: a buyer could pay with one and be licensed to another, and
  // the Paddle invoice and our licence would then name different people permanently. Paddle holds the
  // paying address; it is the only one allowed on the record.
  const html = await read('index.html')

  // Ids are per-rail since 2026-11-24: two live rails each render a licence-entity field, and duplicate DOM
  // ids would break every <label for> on the page.
  assert.match(html, /id="lic-entity-' \+ m\.id/u, 'the checkout must ask who the licence is issued to')
  // A placeholder is not a label: it vanishes on focus and screen readers may skip it.
  assert.match(html, /<label for="lic-entity-' \+ m\.id/u, 'the entity field needs a real label element')
  assert.match(html, /licensee_entity:\s*entity\.value\.trim\(\)/u,
    'the entity must ride on the transaction as customData.licensee_entity')
  assert.match(html, /customData:/u, 'the values must be passed to Checkout.open as customData')

  // The Paddle prohibition survives unchanged: Paddle holds the paying address, so the page must not send it
  // one. Scoped to customData, because the Paystack rail must collect an address — Paystack has no customer
  // record to read back from — and the Worker re-reads it from the verify response rather than trusting it.
  assert.doesNotMatch(html, /customData:\s*\{[^}]*\bemail\b/iu,
    'no address may ride on a Paddle transaction as customData')
  assert.doesNotMatch(html, /customer:\s*\{\s*email/u, 'the storefront must not prefill Paddle with an address')
  assert.match(html, /authorization_url/u, 'the Kenya rail must send the buyer to the checkout Paystack returns')

  const workerSrc = await (await import('node:fs/promises'))
    .readFile(new URL('worker/licence/src/index.js', repo), 'utf8')
  assert.match(workerSrc, /txn\.customer\?\.email/u,
    'the Worker must take the payer address from Paystack verify response, not from the form')

  // The gate must be in front of the door, not behind it.
  const checkAt = html.indexOf('if (!entity.value.trim())')
  const openAt = html.indexOf('window.Paddle.Checkout.open({')
  assert.ok(checkAt > -1, 'the click handler must validate the entity field')
  assert.ok(openAt > -1, 'the Paddle checkout must still open')
  assert.ok(checkAt < openAt,
    'validation must run BEFORE Checkout.open, or an empty licensee reaches Paddle and the licence names nobody')

  // The Worker must resolve the address from Paddle itself, never from anything the browser sent.
  const worker = await (await import('node:fs/promises'))
    .readFile(new URL('worker/licence/src/index.js', repo), 'utf8')
  assert.match(worker, /fetchCustomerEmail\(env, txn\.customer_id\)/u,
    'the Worker must read the address from the transaction customer')
  assert.match(worker, /\/customers\/\$\{customerId\}/u, 'it must read Paddle customer record')
  assert.doesNotMatch(worker, /custom\.buyer_email/u,
    'the Worker must never trust an email supplied by the checkout form')
})

test('every payment rail renders as a primary button, so no payment option is de-emphasised', async () => {
  // Found 2026-11-24, the day the M-Pesa rail went live: only the first rail was styled `btn` and every other
  // rail got `btn secondary`, which is a transparent outline. The effect was that the option a Kenyan buyer most
  // wants looked like the least prominent control on the page. A payment option is not a secondary action.
  const html = await read('index.html')
  const assignments = [...html.matchAll(/control\.className\s*=\s*([^;]+);/gu)].map((m) => m[1].trim())

  assert.ok(assignments.length >= 3,
    `expected a class assignment in each rail branch (Paddle, Paystack, plain link), found ${assignments.length}`)
  for (const value of assignments) {
    assert.doesNotMatch(value, /secondary/u,
      `a payment rail must not be styled as secondary: the branch assigns ${value}`)
  }
  // The free download is not a payment rail and legitimately stays secondary.
  assert.match(html, /free\.className = 'btn secondary'/u,
    'the free-download button is not a rail and should still read as secondary')
})
