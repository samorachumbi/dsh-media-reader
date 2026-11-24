/**
 * The Paystack rail — executed, not inspected.
 *
 * The existing worker guard (`worker-head.test.mjs`) is a source assertion because the module had never
 * been run by the suite. That is not good enough here: the whole risk of this rail is arithmetic and
 * ordering — KSh 10,000 is `1000000` minor units, an amount must be re-read rather than trusted, and a
 * retried webhook must not mint a second licence. So this file imports the real Worker and drives its
 * `fetch` handler with a stub KV, a stub email binding and a stubbed global `fetch` standing in for
 * Paystack.
 *
 * The module has no imports and uses only `crypto.subtle`, `fetch` and standard web types, so it loads
 * directly: package.json has no `"type": "module"`, so a `.js` file is evaluated as ESM through a data URL.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHmac } from 'node:crypto'

const repo = new URL('..', import.meta.url)
const SECRET = 'sk_test_fixture_key'
const ORIGIN = 'https://worker.test'

const workerSource = await readFile(new URL('worker/licence/src/index.js', repo), 'utf8')
const worker = (await import(`data:text/javascript;base64,${Buffer.from(workerSource).toString('base64')}`)).default

/* ───────────────────────────────────────────────────────────────────────────── fixtures ── */

function createKv() {
  const store = new Map()
  return {
    store,
    async get(key, type) {
      if (!store.has(key)) return null
      const raw = store.get(key)
      return type === 'json' ? JSON.parse(raw) : raw
    },
    async put(key, value) { store.set(key, String(value)) },
    async delete(key) { store.delete(key) },
  }
}

function createEnv(overrides = {}) {
  const sent = []
  return {
    sent,
    env: {
      LICENCES: createKv(),
      EMAIL: { async send(message) { sent.push(message); return { messageId: 'stub' } } },
      PAYSTACK_SECRET_KEY: SECRET,
      ARTIFACT_VERSION: '0.1.2',
      ARTIFACT_SHA256: 'a'.repeat(64),
      ARTIFACT_URL: 'https://example.invalid/bundle.tar.gz',
      STORE_URL: 'https://store.itikia.co.ke',
      FROM_EMAIL: 'licence@itikia.co.ke',
      OPERATOR_EMAIL: 'operator@itikia.co.ke',
      ...overrides,
    },
  }
}

const responseJson = (payload, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })

/** Stand in for Paystack. Records every call so the request body itself can be asserted. */
function stubPaystack({ initialize, verify } = {}) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url
    calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null, headers: init.headers ?? {} })
    if (url.endsWith('/transaction/initialize')) {
      return responseJson(initialize ?? {
        status: true,
        data: { authorization_url: 'https://checkout.paystack.com/fixture', access_code: 'ac_fixture' },
      })
    }
    if (url.includes('/transaction/verify/')) {
      return responseJson(verify ?? {
        status: true,
        data: {
          id: 4099260516, status: 'success', reference: 'dsh_fixture', amount: 1000000, currency: 'KES',
          paid_at: '2026-11-24T09:15:02.000Z', customer: { email: 'buyer@example.com' },
        },
      })
    }
    return responseJson({ status: false, message: `unexpected call ${url}` }, 500)
  }
  return { calls, restore() { globalThis.fetch = original } }
}

const signed = (body, secret = SECRET) => createHmac('sha512', secret).update(body).digest('hex')

const init = (payload) => new Request(`${ORIGIN}/paystack/init`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
})

const webhook = (body, signature) => new Request(`${ORIGIN}/paystack/webhook`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-paystack-signature': signature },
  body,
})

const chargeSuccess = (overrides = {}) => JSON.stringify({
  event: 'charge.success',
  data: { id: 4099260516, reference: 'dsh_fixture', status: 'success', amount: 1000000, currency: 'KES',
    paid_at: '2026-11-24T09:15:02.000Z', customer: { email: 'buyer@example.com' }, ...overrides },
})

/** Run init successfully so an order exists in KV to fulfil. */
async function placeOrder(env) {
  const stub = stubPaystack()
  try {
    const response = await worker.fetch(init({ email: 'buyer@example.com', entity: 'Acme Team Ltd' }), env)
    const body = await response.json()
    return body.reference
  } finally {
    stub.restore()
  }
}

/* ─────────────────────────────────────────────────────────────────────────── the amount ── */

test('the expected amount is the storefront KES price in minor units, derived not retyped', async () => {
  const html = await readFile(new URL('store/index.html', repo), 'utf8')
  const cfg = JSON.parse(/<script type="application\/json" id="pay-config">([\s\S]*?)<\/script>/u.exec(html)[1])
  const declared = /const PAYSTACK_AMOUNT_MINOR_DEFAULT = (\d+);/u.exec(workerSource)
  assert.ok(declared, 'the Worker must declare the expected amount explicitly, so this guard has something to check')
  assert.equal(Number(declared[1]), cfg.price.kes * 100,
    `the Worker charges ${declared[1]} minor units but KSh ${cfg.price.kes} is ${cfg.price.kes * 100} — a 100x error sells the licence for one hundredth of its price`)
})

/* ────────────────────────────────────────────────────────────────────────────── init ── */

test('init sends KSh 10,000 as 1000000 minor units in KES, with the licence entity attached', async () => {
  const { env } = createEnv()
  const stub = stubPaystack()
  try {
    const response = await worker.fetch(init({ email: 'buyer@example.com', entity: 'Acme Team Ltd' }), env)
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.match(body.reference, /^dsh_[a-f0-9]{32}$/u, 'the reference must be ours and unguessable')
    assert.equal(body.authorization_url, 'https://checkout.paystack.com/fixture')

    const call = stub.calls.find((c) => c.url.endsWith('/transaction/initialize'))
    assert.ok(call, 'init must call Paystack')
    assert.equal(call.body.amount, 1000000, 'KSh 10,000 is 1000000 minor units')
    assert.equal(call.body.currency, 'KES')
    assert.equal(call.body.email, 'buyer@example.com')
    assert.equal(call.body.metadata.licensee_entity, 'Acme Team Ltd', 'the licence must name an entity')
    assert.equal(call.body.callback_url, `${ORIGIN}/paystack/verify/${body.reference}`)
  } finally {
    stub.restore()
  }
})

test('every Paystack call carries a real User-Agent, because Cloudflare refuses bot-looking clients with 403/1010', async () => {
  const { env } = createEnv()
  const stub = stubPaystack()
  try {
    await worker.fetch(init({ email: 'buyer@example.com', entity: 'Acme Team Ltd' }), env)
    const call = stub.calls[0]
    assert.ok(call.headers['user-agent']?.includes('dsh-media-reader-licence'),
      `a bare client is answered by Cloudflare's bot filter with 403 error 1010, which reads exactly like a rejected key — got ${JSON.stringify(call.headers['user-agent'])}`)
    assert.equal(call.headers.authorization, `Bearer ${SECRET}`)
  } finally {
    stub.restore()
  }
})

test('init refuses an order it could not issue a licence for', async () => {
  const { env } = createEnv()
  for (const [payload, reason] of [
    [{ email: 'not-an-email', entity: 'Acme' }, 'invalid_email'],
    [{ email: 'buyer@example.com' }, 'missing_licensee_entity'],
    [{ email: 'buyer@example.com', entity: '   ' }, 'missing_licensee_entity'],
  ]) {
    const stub = stubPaystack()
    try {
      const response = await worker.fetch(init(payload), env)
      assert.equal(response.status, 400, `${JSON.stringify(payload)} must be refused`)
      assert.equal((await response.json()).error, reason)
      assert.equal(stub.calls.length, 0, 'a refused order must not reach Paystack')
    } finally {
      stub.restore()
    }
  }
})

/* ─────────────────────────────────────────────────────────────────────────── webhook ── */

test('a signed charge.success issues exactly one licence, to the verified address', async () => {
  const { env, sent } = createEnv()
  const reference = await placeOrder(env)

  const stub = stubPaystack({
    verify: { status: true, data: { id: 42, status: 'success', reference, amount: 1000000, currency: 'KES',
      paid_at: '2026-11-24T09:15:02.000Z', customer: { email: 'buyer@example.com' } } },
  })
  try {
    const body = chargeSuccess({ reference })
    const response = await worker.fetch(webhook(body, signed(body)), env)
    const result = await response.json()

    assert.equal(response.status, 200)
    assert.equal(result.issued, true, `expected a licence, got ${JSON.stringify(result)}`)
    assert.match(result.link, /\/licence\/[a-f0-9]{32}$/u)

    const token = result.link.split('/').pop()
    const record = await env.LICENCES.get(`lic:${token}`, 'json')
    assert.ok(record, 'the licence document must be stored')
    assert.equal(record.entity, 'Acme Team Ltd', 'the stored entity comes from the order, not the callback body')
    assert.equal(record.email, 'buyer@example.com')
    assert.equal(record.rail, 'paystack')
    assert.ok(sent.length >= 1, 'the buyer must be emailed')
    assert.ok(await env.LICENCES.get(`ps:paid:${reference}`), 'the idempotency key must be written')
  } finally {
    stub.restore()
  }
})

test('a body that does not match its signature is refused before it is parsed', async () => {
  const { env } = createEnv()
  const reference = await placeOrder(env)
  const stub = stubPaystack()
  try {
    const body = chargeSuccess({ reference })
    const response = await worker.fetch(webhook(body, signed('{"something":"else"}')), env)
    assert.equal(response.status, 401, 'an unverified body must be refused with 401, before it is parsed')
    assert.equal((await response.json()).error, 'invalid_signature')
    assert.equal(stub.calls.length, 0, 'an unverified body must not even trigger a verify call')
  } finally {
    stub.restore()
  }
})

test('a missing signature header is refused, not treated as a classic-scheme event', async () => {
  const { env } = createEnv()
  const response = await worker.fetch(new Request(`${ORIGIN}/paystack/webhook`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: chargeSuccess(),
  }), env)
  assert.equal(response.status, 401)
  assert.equal((await response.json()).reason, 'missing_header')
})

test('a valid signature over a payment of the wrong amount issues nothing', async () => {
  const { env } = createEnv()
  const reference = await placeOrder(env)
  // The signature is valid — provenance is proven. The amount is still a lie, which is why it is re-read.
  const stub = stubPaystack({
    verify: { status: true, data: { id: 43, status: 'success', reference, amount: 100, currency: 'KES',
      paid_at: '2026-11-24T09:15:02.000Z', customer: { email: 'buyer@example.com' } } },
  })
  try {
    const body = chargeSuccess({ reference, amount: 1000000 })   // the body CLAIMS the full amount
    const response = await worker.fetch(webhook(body, signed(body)), env)
    const result = await response.json()

    assert.equal(result.needs_manual_issue, true, `a KSh 1 payment must not issue a KSh 10,000 licence: ${JSON.stringify(result)}`)
    assert.equal(result.reason, 'amount_mismatch')
    assert.equal(await env.LICENCES.get(`ps:paid:${reference}`), null, 'no idempotency key may be written')
    const licences = [...env.LICENCES.store.keys()].filter((k) => k.startsWith('lic:'))
    assert.equal(licences.length, 0, 'no licence document may exist')
  } finally {
    stub.restore()
  }
})

test('a payment in the wrong currency issues nothing', async () => {
  const { env } = createEnv()
  const reference = await placeOrder(env)
  const stub = stubPaystack({
    verify: { status: true, data: { id: 44, status: 'success', reference, amount: 1000000, currency: 'USD',
      paid_at: '2026-11-24T09:15:02.000Z', customer: { email: 'buyer@example.com' } } },
  })
  try {
    const body = chargeSuccess({ reference })
    const result = await (await worker.fetch(webhook(body, signed(body)), env)).json()
    assert.equal(result.reason, 'currency_mismatch')
  } finally {
    stub.restore()
  }
})

test('a replayed webhook mints one licence, not two', async () => {
  const { env } = createEnv()
  const reference = await placeOrder(env)
  const stub = stubPaystack({
    verify: { status: true, data: { id: 45, status: 'success', reference, amount: 1000000, currency: 'KES',
      paid_at: '2026-11-24T09:15:02.000Z', customer: { email: 'buyer@example.com' } } },
  })
  try {
    const body = chargeSuccess({ reference })
    const first = await (await worker.fetch(webhook(body, signed(body)), env)).json()
    const second = await (await worker.fetch(webhook(body, signed(body)), env)).json()

    assert.equal(first.issued, true)
    assert.equal(second.duplicate, true, `a retry must not issue again: ${JSON.stringify(second)}`)
    assert.equal([...env.LICENCES.store.keys()].filter((k) => k.startsWith('lic:')).length, 1)
  } finally {
    stub.restore()
  }
})

test('an unknown reference is ignored even with a valid signature', async () => {
  const { env } = createEnv()
  const stub = stubPaystack()
  try {
    const body = chargeSuccess({ reference: 'dsh_never_created' })
    const result = await (await worker.fetch(webhook(body, signed(body)), env)).json()
    assert.equal(result.ignored, 'unknown_reference', 'a posted body alone can never mint a licence')
    assert.equal(stub.calls.length, 0, 'an unknown reference must not even reach the verify API')
  } finally {
    stub.restore()
  }
})

test('the timestamped signature scheme is accepted as well as the classic one', async () => {
  const { env } = createEnv()
  const reference = await placeOrder(env)
  const stub = stubPaystack({
    verify: { status: true, data: { id: 46, status: 'success', reference, amount: 1000000, currency: 'KES',
      paid_at: '2026-11-24T09:15:02.000Z', customer: { email: 'buyer@example.com' } } },
  })
  try {
    const body = chargeSuccess({ reference })
    const timestamp = Math.floor(Date.now() / 1000)
    const signature = createHmac('sha512', SECRET).update(`${timestamp}.${body}`).digest('hex')
    const result = await (await worker.fetch(webhook(body, `t=${timestamp},v1=whk_abc123:${signature}`), env)).json()
    assert.equal(result.issued, true, `the documented timestamped scheme must be handled: ${JSON.stringify(result)}`)
  } finally {
    stub.restore()
  }
})

/* ──────────────────────────────────────────────────────────────── the return route ── */

test('the return route issues on success and resolves a cancelled prompt', async () => {
  const { env } = createEnv()
  const reference = await placeOrder(env)

  // Cancelled: Paystack never sends a webhook for this, which is exactly why the route exists.
  let stub = stubPaystack({
    verify: { status: true, data: { id: 47, status: 'failed', reference, amount: 1000000, currency: 'KES',
      customer: { email: 'buyer@example.com' } } },
  })
  try {
    const result = await (await worker.fetch(new Request(`${ORIGIN}/paystack/verify/${reference}`), env)).json()
    assert.equal(result.ignored, 'status:failed', 'a cancelled payment must resolve, not hang as pending forever')
    assert.equal(await env.LICENCES.get(`ps:paid:${reference}`), null)
  } finally {
    stub.restore()
  }

  stub = stubPaystack({
    verify: { status: true, data: { id: 48, status: 'success', reference, amount: 1000000, currency: 'KES',
      paid_at: '2026-11-24T09:15:02.000Z', customer: { email: 'buyer@example.com' } } },
  })
  try {
    const result = await (await worker.fetch(new Request(`${ORIGIN}/paystack/verify/${reference}`), env)).json()
    assert.equal(result.issued, true, 'a buyer who returns after paying must get the licence even if the webhook is late')
  } finally {
    stub.restore()
  }
})

/* ──────────────────────────────────────────────────────────────────────────────── cors ── */

test('the browser preflight is answered, or the storefront cannot call init at all', async () => {
  const { env } = createEnv()
  const response = await worker.fetch(new Request(`${ORIGIN}/paystack/init`, {
    method: 'OPTIONS', headers: { origin: 'https://store.itikia.co.ke', 'access-control-request-method': 'POST' },
  }), env)
  assert.equal(response.status, 204, 'the preflight must be answered with 204, not fall through to the 404 branch')
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://store.itikia.co.ke',
    'the storefront origin must be allowed, or every checkout POST is blocked by the browser')
  assert.match(String(response.headers.get('access-control-allow-methods')), /POST/u)
  assert.match(String(response.headers.get('access-control-allow-headers')), /content-type/iu)
})

test('every init response carries the CORS header, including the refusals', async () => {
  const { env } = createEnv()
  const stub = stubPaystack()
  try {
    for (const [payload, label] of [
      [{ email: 'buyer@example.com', entity: 'Acme Team Ltd' }, 'success'],
      [{ email: 'nope', entity: 'Acme' }, 'invalid_email'],
      [{ email: 'buyer@example.com' }, 'missing_entity'],
    ]) {
      const response = await worker.fetch(init(payload), env)
      assert.equal(response.headers.get('access-control-allow-origin'), 'https://store.itikia.co.ke',
        `${label}: a refusal the browser cannot read is a failure the buyer never sees`)
    }
  } finally {
    stub.restore()
  }
})

test('CORS is scoped to the checkout: the licence route is not made cross-origin readable', async () => {
  const { env } = createEnv()
  const response = await worker.fetch(new Request(`${ORIGIN}/licence/${'0'.repeat(32)}`), env)
  assert.equal(response.headers.get('access-control-allow-origin'), null,
    'a licence document must not become readable from any origin that asks for it')
})
