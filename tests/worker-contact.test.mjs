/**
 * The storefront contact form — executed, not inspected.
 *
 * This endpoint sends mail to a real address on behalf of anyone who can reach it, so the risks are not
 * cosmetic: an open relay for spam, a bot filling it in a loop, a message a real person wrote being silently
 * dropped, and a sender's address going somewhere other than the reply button. Each of those is a test here,
 * and the Worker is executed rather than read, because a source assertion cannot tell you what gets sent.
 *
 * The one thing no test can prove is delivery — that is the operator's inbox. What is provable is that
 * exactly one message with the right recipient, subject and reply-to leaves the Worker, and that nothing
 * leaves it for the wrong reason.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const repo = new URL('..', import.meta.url)
const ORIGIN = 'https://store.itikia.co.ke'
const workerSource = await readFile(new URL('worker/licence/src/index.js', repo), 'utf8')
const worker = (await import(`data:text/javascript;base64,${Buffer.from(workerSource).toString('base64')}`)).default

function createKv() {
  const store = new Map()
  return {
    store,
    async get(key) {
      return store.has(key) ? store.get(key) : null
    },
    async put(key, value) {
      store.set(key, String(value))
    },
    async delete(key) {
      store.delete(key)
    },
  }
}

function createEnv(overrides = {}) {
  const sent = []
  return {
    sent,
    env: {
      LICENCES: createKv(),
      EMAIL: {
        async send(message) {
          sent.push(message)
          return { messageId: 'stub' }
        },
      },
      ARTIFACT_VERSION: '0.1.2',
      ARTIFACT_SHA256: 'a'.repeat(64),
      ARTIFACT_URL: 'https://example.invalid/bundle.tar.gz',
      STORE_URL: ORIGIN,
      FROM_EMAIL: 'licence@itikia.co.ke',
      CONTACT_TO: 'samora@itikia.co.ke',
      OPERATOR_EMAIL: 'operator@itikia.co.ke',
      ...overrides,
    },
  }
}

const GOOD = {
  name: 'Ada Buyer',
  email: 'ada@example.com',
  entity: 'Acme Ltd',
  topic: 'purchase',
  message: 'We have four editors on Windows and want to know if one licence covers them.',
  website: '',
  elapsedMs: 9000,
}

function post(body, { origin = ORIGIN, contentType = 'application/json', ip = '203.0.113.7' } = {}) {
  const headers = { 'content-type': contentType, 'cf-connecting-ip': ip }
  if (origin !== null) headers.origin = origin
  return new Request('https://worker.test/contact', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

/* ───────────────────────────────────────────────────────────────────────── the happy path ── */

test('a real enquiry sends exactly one email, addressed to a human, with the sender as reply-to', async () => {
  const { env, sent } = createEnv()
  const response = await worker.fetch(post(GOOD), env)
  const body = await response.json()

  assert.equal(response.status, 200)
  assert.deepEqual(body, { ok: true }, 'the response confirms delivery, nothing more')
  assert.equal(sent.length, 1, 'exactly one message, never a copy to the sender')

  const message = sent[0]
  assert.equal(message.to, 'samora@itikia.co.ke', 'it must go to the address the page promises')
  assert.equal(message.from, 'licence@itikia.co.ke')
  assert.equal(message.replyTo, 'ada@example.com', 'Reply must reach the sender, not a robot')
  assert.match(message.subject, /buying \/ team use/, 'the subject carries the topic so it can be triaged')
  assert.match(message.subject, /Ada Buyer/)
  for (const field of ['ada@example.com', 'Acme Ltd', 'four editors']) {
    assert.ok(message.text.includes(field), `the operator's copy must contain ${field}`)
  }
})

test('the response never echoes what the sender wrote', async () => {
  const { env } = createEnv()
  const response = await worker.fetch(post(GOOD), env)
  const text = await response.text()
  assert.equal(text, '{"ok":true}', 'a copy of the message in the response is a copy in every log in between')
})

test('a fast submit is delivered but marked, because a timing heuristic must never eat a real message', async () => {
  // Autofill and password managers make sub-1.5s submissions genuinely possible. Silently dropping one would
  // be the worst failure this endpoint has: the sender believes they wrote to the seller and nobody ever knows.
  const { env, sent } = createEnv()
  const response = await worker.fetch(post({ ...GOOD, elapsedMs: 300 }), env)
  assert.equal(response.status, 200)
  assert.equal(sent.length, 1, 'a fast human still gets delivered')
  assert.match(sent[0].subject, /fast submit/, 'but the operator is told it looked automated')
  assert.match(sent[0].text, /filled in 300ms/)
})

/* ───────────────────────────────────────────────────────────────────────── the anti-abuse ── */

test('the honeypot drops a bot silently: 200, and no mail at all', async () => {
  const { env, sent } = createEnv()
  const response = await worker.fetch(post({ ...GOOD, website: 'http://spam.example' }), env)
  assert.equal(response.status, 200, 'a 4xx would teach the bot which field to leave empty')
  assert.deepEqual(await response.json(), { ok: true })
  assert.equal(sent.length, 0, 'nothing may leave the Worker for a submission that failed the honeypot')
})

test('a second message from the same connection inside a minute is refused with a retry hint', async () => {
  const { env, sent } = createEnv()
  const first = await worker.fetch(post(GOOD), env)
  assert.equal(first.status, 200)

  const second = await worker.fetch(post({ ...GOOD, message: 'and another thing entirely here' }), env)
  assert.equal(second.status, 429)
  const body = await second.json()
  assert.equal(body.error, 'too_many')
  assert.equal(second.headers.get('retry-after'), '60', 'the page tells the visitor how long to wait')
  assert.equal(sent.length, 1, 'the flood stops at the second message, not the twentieth')
})

test('a different connection is not punished for someone else’s traffic', async () => {
  const { env } = createEnv()
  await worker.fetch(post(GOOD, { ip: '203.0.113.7' }), env)
  const other = await worker.fetch(post(GOOD, { ip: '198.51.100.9' }), env)
  assert.equal(other.status, 200, 'the limit is per caller, not global')
})

test('the daily cap stops a slow loop that the minute limit would let through', async () => {
  const { env, sent } = createEnv()
  // Same connection, a different minute each time: clear only the minute window between sends, so the day
  // counter accumulates exactly as it would over a slow loop.
  const clearMinuteKeys = () => {
    for (const key of [...env.LICENCES.store.keys()]) {
      if (key.startsWith('contact:minute:')) env.LICENCES.store.delete(key)
    }
  }

  for (let i = 0; i < 5; i += 1) {
    const response = await worker.fetch(post({ ...GOOD, message: `message number ${i}, long enough to send` }), env)
    assert.equal(response.status, 200, `message ${i} should be accepted`)
    clearMinuteKeys()
  }

  const sixth = await worker.fetch(post({ ...GOOD, message: 'the sixth message in one day, long enough' }), env)
  assert.equal(sixth.status, 429)
  assert.equal(await sixth.json().then((b) => b.error), 'too_many_today')
  assert.equal(sent.length, 5, 'five a day per connection is the ceiling')
})

test('the rate limiter stores a hash, never the caller’s address', async () => {
  const { env } = createEnv()
  await worker.fetch(post(GOOD, { ip: '203.0.113.77' }), env)
  const keys = [...env.LICENCES.store.keys()]
  assert.ok(keys.length >= 2, 'a minute key and a day key')
  for (const key of keys) {
    assert.doesNotMatch(key, /203\.0\.113\.77/u, 'the raw IP must not appear in KV')
    assert.match(key, /^contact:(minute|day):[a-f0-9]{24}$/u, `unexpected key shape: ${key}`)
  }
})

/* ─────────────────────────────────────────────────────────────────────── who may call it ── */

test('another website cannot use this Worker as a mail relay', async () => {
  // CORS stops a foreign page READING the reply. It does not stop the request: a simple POST would deliver
  // mail from someone else's site. The origin check is what closes that.
  const { env, sent } = createEnv()
  const response = await worker.fetch(post(GOOD, { origin: 'https://evil.example' }), env)
  assert.equal(response.status, 403)
  assert.equal((await response.json()).error, 'origin_not_allowed')
  assert.equal(sent.length, 0, 'no mail for a foreign origin')
})

test('a request with no origin is refused: this endpoint exists for one page', async () => {
  const { env, sent } = createEnv()
  const response = await worker.fetch(post(GOOD, { origin: null }), env)
  assert.equal(response.status, 403)
  assert.equal(sent.length, 0)
})

test('a non-JSON body is refused, so a plain form post cannot skip the preflight', async () => {
  const { env, sent } = createEnv()
  const response = await worker.fetch(post('name=x&message=y', { contentType: 'application/x-www-form-urlencoded' }), env)
  assert.equal(response.status, 415)
  assert.equal(sent.length, 0)
})

test('the preflight is answered for the store origin with POST only', async () => {
  const { env } = createEnv()
  const response = await worker.fetch(new Request('https://worker.test/contact', {
    method: 'OPTIONS',
    headers: { origin: ORIGIN, 'access-control-request-method': 'POST' },
  }), env)
  assert.equal(response.status, 204)
  assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN)
  assert.match(response.headers.get('access-control-allow-methods'), /POST/u)
  assert.doesNotMatch(response.headers.get('access-control-allow-methods'), /PUT|DELETE/u)
})

/* ──────────────────────────────────────────────────────────────────────────── validation ── */

test('every invalid field is named, and nothing is sent', async () => {
  const { env, sent } = createEnv()
  const response = await worker.fetch(post({ name: 'A', email: 'not-an-email', message: 'short', topic: 'nonsense' }), env)
  assert.equal(response.status, 400)
  const body = await response.json()
  assert.equal(body.error, 'invalid_fields')
  assert.deepEqual(Object.keys(body.fields).sort(), ['email', 'message', 'name'])
  assert.equal(sent.length, 0)
})

test('an unknown topic is coerced rather than trusted, and oversized text is refused', async () => {
  const { env, sent } = createEnv()
  const coerced = await worker.fetch(post({ ...GOOD, topic: 'invoice; rm -rf /' }), env)
  assert.equal(coerced.status, 200)
  assert.match(sent[0].subject, /something else/, 'an unknown topic becomes "other", it is not interpolated')

  const huge = await worker.fetch(post({ ...GOOD, message: 'x'.repeat(4001), elapsedMs: 9000 }, { ip: '198.51.100.4' }), env)
  assert.equal(huge.status, 400)
  assert.equal(sent.length, 1, 'the oversized message is not sent')
})

test('HTML in the message is escaped in the operator’s copy', async () => {
  const { env, sent } = createEnv()
  const response = await worker.fetch(post({ ...GOOD, message: '<script>alert(1)</script> and some more words' }), env)
  assert.equal(response.status, 200)
  assert.doesNotMatch(sent[0].html, /<script>/u, 'user text never becomes markup in the email')
  assert.match(sent[0].html, /&lt;script&gt;/u)
})

test('a failed send is reported as failed, not as delivered', async () => {
  const { env } = createEnv({
    EMAIL: { async send() { throw new Error('binding unavailable') } },
  })
  const response = await worker.fetch(post(GOOD), env)
  assert.equal(response.status, 502)
  assert.equal((await response.json()).error, 'send_failed')
})
