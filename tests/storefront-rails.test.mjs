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

test('no rail is claimed live until a real payment has been seen', async () => {
  const cfg = payConfig(await read('index.html'))
  const live = cfg.methods.filter((m) => m.verified && (m.kind === 'paddle' ? m.priceId && m.clientToken : m.url))
  // When a rail goes live this assertion flips deliberately — update the page's wording with it.
  assert.equal(live.length, 0, `these rails are claimed live without a recorded payment: ${live.map((m) => m.id)}`)

  const html = await read('index.html')
  assert.match(html, /Checkout is not open yet/u, 'with no live rail the page must say so')
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
