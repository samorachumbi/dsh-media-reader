/**
 * dsh-media-reader licence issuer — the half of fulfilment Paddle cannot do.
 *
 * Paddle, as merchant of record, does the payment half automatically: it charges, computes tax,
 * creates the customer and the transaction, and emails the invoice. It never emits the licence,
 * and it collects an email but never a company, so on 2026-11-16 the first real order produced a
 * tax invoice and no licence at all, with the licensee recorded as `null` — see the vault note
 * `an-invoice-is-not-a-delivery`.
 *
 * This Worker closes that gap end to end:
 *   POST /paddle        Paddle webhook. Signature-verified, idempotent, gated on
 *                       `transaction.completed`. Issues the licence, stores it under an
 *                       unguessable token, emails the buyer, and alerts the operator.
 *   GET  /licence/<tok> The document itself, as a Markdown download.
 *   GET  /              Health, so a bad deploy is visible without reading logs.
 *
 * Deliberate design decisions, each of which has already been a defect somewhere:
 *
 *   1. NOTHING is issued without a verified signature. The body is read as text and the HMAC is
 *      computed over the exact bytes received; parsing first and re-serialising would change them.
 *   2. The handler is idempotent. Paddle retries, so `order:<txn_id>` is checked first; a retry
 *      must not mint a second licence with a second token.
 *   3. An order that arrives without a licensee entity is NOT issued. It is reported to the
 *      operator instead, because a licence that names nobody is worse than a delay.
 *   4. The artifact version and sha256 are deploy-time variables, not constants. They are injected
 *      from dist/ so the document can never name a hash this deployment did not verify.
 *   5. The signature is typed (`Samora Chumbi`), which is public information — that is exactly why
 *      this document can be completed in the cloud. A cryptographic key would have to stay on the
 *      operator's machine, and the Worker could then only ever emit unsigned drafts.
 */

const SIGNATURE_TOLERANCE_SECONDS = 300;
const TOKEN_PATTERN = /^[a-f0-9]{32}$/u;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/paddle') {
      return handlePaddleWebhook(request, env);
    }
    // GET *and* HEAD. A HEAD that falls through to the 404 branch makes every link previewer, download
    // manager, uptime probe and `curl -I` report a working licence as missing — found 2026-11-21, when a
    // licence that downloaded perfectly answered HEAD with 404 JSON. HEAD must mirror GET's status and
    // headers; only the body differs.
    const isRead = request.method === 'GET' || request.method === 'HEAD';
    if (isRead && TOKEN_PATTERN.test(url.pathname.slice('/licence/'.length)) &&
        url.pathname.startsWith('/licence/')) {
      return serveLicence(url, env, request.method);
    }
    // The Kenyan rail. Paystack is a GATEWAY, not a merchant of record: the order is ITIKIA's, the tax
    // is ITIKIA's problem, and the 14-day refund on /refund becomes something an operator performs.
    if (request.method === 'POST' && url.pathname === '/paystack/init') {
      return paystackInit(request, env);
    }
    if (request.method === 'POST' && url.pathname === '/paystack/webhook') {
      return handlePaystackWebhook(request, env);
    }
    if (isRead && url.pathname.startsWith('/paystack/verify/')) {
      return paystackVerifyRoute(url, env, request.method);
    }
    if (isRead && (url.pathname === '/' || url.pathname === '/health')) {
      return json({ ok: true, service: 'dsh-media-reader licence issuer', artifact: env.ARTIFACT_VERSION },
        200, request.method);
    }
    return json({ error: 'not_found' }, 404);
  },
};

/* ────────────────────────────────────────────────────────────────────────── webhook ── */

async function handlePaddleWebhook(request, env) {
  // Read the raw text FIRST: the HMAC is over the exact bytes Paddle sent.
  const body = await request.text();

  const check = await verifySignature(
    env.PADDLE_WEBHOOK_SECRET,
    request.headers.get('Paddle-Signature'),
    body,
    Date.now(),
  );
  if (!check.ok) {
    // A rejected signature is a security event, not a validation detail. Log the reason only —
    // never the secret, never the body.
    console.warn('rejected webhook:', check.reason);
    return json({ error: 'invalid_signature', reason: check.reason }, 401);
  }

  let event;
  try {
    event = JSON.parse(body);
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  // Accept and ignore everything else, so Paddle does not retry unrelated events forever.
  if (event.event_type !== 'transaction.completed') {
    return json({ ignored: event.event_type ?? 'unknown' }, 200);
  }

  const txn = event.data ?? {};
  if (txn.status !== 'completed') {
    return json({ ignored: `status:${txn.status}` }, 200);
  }

  const orderKey = `order:${txn.id}`;
  if (await env.LICENCES.get(orderKey)) {
    // Paddle retried an order we already fulfilled. Minting a second licence here would give the
    // buyer two apparently-valid documents for one payment.
    return json({ duplicate: true, transaction: txn.id }, 200);
  }

  const custom = txn.custom_data ?? {};
  // Which channel produced this sale, recorded on the order itself. The storefront attached the
  // campaign tags it found on the visitor's URL; the client sent them, so they are re-sanitised here
  // for the same reasons the storefront sanitised them. A missing or unusable tag becomes `unknown`
  // and never blocks a paid order — attribution is evidence, not a gate.
  const attribution = readAttribution(custom);
  const entity = String(custom.licensee_entity ?? '').trim();
  const reference = String(txn.invoice_number ?? txn.id);
  const issued = String(txn.billed_at ?? new Date().toISOString()).slice(0, 10);
  const origin = new URL(request.url).origin;

  // The delivery address is read back from PADDLE, never taken from the storefront. Two email fields
  // on one transaction lets a buyer pay with one address and be licensed to another, after which the
  // invoice and the licence name different people permanently. Paddle's customer record is the single
  // authority: it is the address the receipt was actually sent to.
  const lookup = await fetchCustomerEmail(env, txn.customer_id);

  // Rule 3: never issue a licence that names nobody, and never guess an address.
  if (!entity || !lookup.ok) {
    await notifyOperator(env, {
      problem: !entity
        ? 'Order paid but carries no licensee entity (checkout form bypassed, or the order predates the form).'
        : `Order paid but the paying address could not be read from Paddle: ${lookup.reason}`,
      reference, txn, custom, origin, link: null, email: lookup.email ?? null,
    });
    return json({ needs_manual_issue: true, reference, reason: lookup.ok ? 'no_licensee_entity' : lookup.reason }, 200);
  }
  const email = lookup.email;

  const doc = buildLicence(env, { entity, email, reference, issued });
  const token = randomToken();
  const link = `${origin}/licence/${token}`;

  // Store the document, then the idempotency key. If the second write fails the buyer has already
  // been emailed, and a retry re-issues — visibly, to the operator — rather than silently nothing.
  await env.LICENCES.put(`lic:${token}`, JSON.stringify({
    reference, entity, email, transaction: txn.id, issued, created: new Date().toISOString(), doc,
    attribution,
  }));

  await sendBuyerEmail(env, { email, entity, reference, link, issued });
  await env.LICENCES.put(orderKey, token);
  await notifyOperator(env, { problem: null, reference, txn, custom, origin, link, entity, email });

  return json({ issued: true, reference, link }, 200);
}

/* ───────────────────────────────────────────────────────────────────── paddle api ── */

/**
 * Read the buyer's address from Paddle — the ONLY email on record for a transaction.
 *
 * Deliberately narrow: one GET, one field, no other Paddle call anywhere in this Worker. The key
 * behind it carries far more than this job needs (it can issue refunds), so this function is the
 * entire blast radius of putting it in the cloud. Swap PADDLE_API_KEY for a key holding only
 * `customer.read` as soon as one exists — Paddle does not allow API-key creation through its API,
 * so that swap has to be done in the dashboard.
 */
/* ────────────────────────────────────────────────────────────────────── paystack ── */

/**
 * Kenyan rail — M-Pesa and cards through Paystack.
 *
 * Three rules decide the shape of everything below:
 *
 *   1. **An acknowledgement is not a payment.** The hosted flow returns a redirect and, for M-Pesa, an STK
 *      prompt on the buyer's phone. None of that is money. Paystack sends the `charge.success` webhook only
 *      for successes, so a cancelled prompt never arrives at all and must be resolved by verification.
 *   2. **A valid signature proves provenance, not truth.** The body is still sender-controlled, so amount
 *      and currency are re-read from the Verify API before any licence exists.
 *   3. **Amounts are minor units.** KSh 10,000 is `1000000`. A factor-of-100 error sells a KSh 10,000
 *      licence for KSh 100 and nothing else would notice, so the expected amount is asserted against the
 *      storefront's own price by the test suite.
 */

// Must equal `#pay-config.price.kes` x 100. The equality is asserted by tests/worker-paystack.test.mjs;
// this copy exists only because a Worker cannot read a static page's JSON block cheaply.
const PAYSTACK_AMOUNT_MINOR_DEFAULT = 1000000;
const PAYSTACK_CURRENCY = 'KES';
const PAYSTACK_API = 'https://api.paystack.co';
const PAYSTACK_ORDER_TTL_SECONDS = 60 * 60 * 24 * 7;

function paystackAmountMinor(env) {
  const configured = Number(env.PAYSTACK_AMOUNT_MINOR ?? PAYSTACK_AMOUNT_MINOR_DEFAULT);
  return Number.isInteger(configured) && configured > 0 ? configured : PAYSTACK_AMOUNT_MINOR_DEFAULT;
}

/**
 * The one place that talks to Paystack, so the User-Agent is set exactly once.
 *
 * Paystack sits behind Cloudflare, which refuses bot-looking clients with **HTTP 403 and `error code:
 * 1010`**. That looks identical to a rejected API key and is not one — a session that read it as an auth
 * failure discarded a working key. Hence the explicit User-Agent.
 */
async function paystackFetch(env, path, init = {}) {
  if (!env.PAYSTACK_SECRET_KEY) return { status: 0, ok: false, body: null, reason: 'no_secret_configured' };
  const response = await fetch(`${PAYSTACK_API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`,
      'content-type': 'application/json',
      'user-agent': 'dsh-media-reader-licence/1.0 (+https://store.itikia.co.ke)',
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    // A non-JSON body from a JSON API means the edge answered, not the API. Leave body null so the caller
    // treats it as a failed call instead of crashing on `.data.status`.
  }
  return { status: response.status, ok: response.ok, body, text };
}

/** Start a checkout. Returns where to send the buyer — never a licence, never a payment. */
async function paystackInit(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'invalid_json' }, 400, request.method);
  }

  const email = String(payload?.email ?? '').trim();
  const entity = String(payload?.entity ?? '').trim();
  if (!isEmail(email)) return json({ error: 'invalid_email' }, 400, request.method);
  // The licence names a legal entity. A licence that names nobody cannot be issued, and guessing one is
  // worse than refusing.
  if (!entity) return json({ error: 'missing_licensee_entity' }, 400, request.method);

  const reference = `dsh_${randomToken()}`;
  const amount = paystackAmountMinor(env);
  const origin = new URL(request.url).origin;
  const attribution = readAttribution(payload?.utm ?? {});

  const created = await paystackFetch(env, '/transaction/initialize', {
    method: 'POST',
    body: JSON.stringify({
      email,
      amount,
      currency: PAYSTACK_CURRENCY,
      reference,
      callback_url: `${origin}/paystack/verify/${reference}`,
      metadata: { licensee_entity: entity, ...attribution },
    }),
  });

  if (!created.ok || !created.body?.status) {
    console.warn('paystack initialize failed:', created.status, created.body?.message ?? created.reason ?? '');
    return json({ error: 'paystack_init_failed', status: created.status }, 502, request.method);
  }

  // The order is what a webhook is matched against. Without it an unknown reference has nothing to fulfil,
  // which is the point: a posted body alone can never mint a licence.
  await env.LICENCES.put(`ps:order:${reference}`, JSON.stringify({
    email, entity, attribution, amount, currency: PAYSTACK_CURRENCY, created: new Date().toISOString(),
  }), { expirationTtl: PAYSTACK_ORDER_TTL_SECONDS });

  return json({
    reference,
    authorization_url: created.body.data?.authorization_url ?? null,
    access_code: created.body.data?.access_code ?? null,
  }, 200, request.method);
}

async function handlePaystackWebhook(request, env) {
  // Raw text first: the signature is over the exact bytes sent.
  const raw = await request.text();
  const check = await verifyPaystackSignature(
    env.PAYSTACK_SECRET_KEY, request.headers.get('x-paystack-signature'), raw,
  );
  if (!check.ok) {
    console.warn('rejected paystack webhook:', check.reason);
    return json({ error: 'invalid_signature', reason: check.reason }, 401);
  }

  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  // Everything else is acknowledged and ignored, so Paystack stops retrying it.
  if (event?.event !== 'charge.success') return json({ ignored: event?.event ?? 'unknown' }, 200);

  const reference = String(event.data?.reference ?? '');
  if (!reference) return json({ error: 'missing_reference' }, 400);

  const outcome = await fulfilPaystackOrder(env, reference, new URL(request.url).origin);
  return json(outcome.body, outcome.status);
}

/** Where the buyer's browser lands after paying — including when they cancelled. Never trusts the query. */
async function paystackVerifyRoute(url, env, method) {
  const reference = decodeURIComponent(url.pathname.slice('/paystack/verify/'.length));
  if (!reference) return json({ error: 'missing_reference' }, 400, method);
  const outcome = await fulfilPaystackOrder(env, reference, new URL(url).origin);
  return json(outcome.body, outcome.status, method);
}

/**
 * Turn a reference into a licence — only if Paystack itself confirms a payment of the right amount in the
 * right currency. Shared by the webhook and the return route so the two cannot drift, and safe to call
 * repeatedly, because that is exactly what a retried webhook is.
 */
async function fulfilPaystackOrder(env, reference, origin) {
  const paidKey = `ps:paid:${reference}`;
  if (await env.LICENCES.get(paidKey)) {
    // A retry, or the buyer reloading the return page. A second licence for one payment would be two
    // apparently-valid documents naming the same order.
    return { status: 200, body: { duplicate: true, reference } };
  }

  const order = await env.LICENCES.get(`ps:order:${reference}`, 'json');
  if (!order) {
    // Ignored rather than refused: an unknown reference is not evidence of anything.
    return { status: 200, body: { ignored: 'unknown_reference', reference } };
  }

  const verified = await paystackFetch(env, `/transaction/verify/${encodeURIComponent(reference)}`);
  const txn = verified.body?.data;
  if (!verified.ok || !verified.body?.status || !txn) {
    return { status: 502, body: { error: 'verify_failed', status: verified.status } };
  }

  const email = String(txn.customer?.email ?? '').trim();
  const entity = String(order.entity ?? '').trim();

  if (txn.status !== 'success') {
    return { status: 200, body: { ignored: `status:${txn.status}`, reference } };
  }

  // Two ways for the money to be wrong, and both stop the licence dead.
  const expected = paystackAmountMinor(env);
  if (Number(txn.amount) !== expected) {
    await notifyOperator(env, {
      problem: `Paystack payment of ${txn.amount} ${txn.currency} does not equal ${expected} ${PAYSTACK_CURRENCY} — NO licence issued.`,
      reference, txn, custom: order, origin, link: null, email,
    });
    return { status: 200, body: { needs_manual_issue: true, reference, reason: 'amount_mismatch' } };
  }
  if (String(txn.currency ?? '').toUpperCase() !== PAYSTACK_CURRENCY) {
    await notifyOperator(env, {
      problem: `Paystack charged ${txn.currency}, not ${PAYSTACK_CURRENCY} — NO licence issued.`,
      reference, txn, custom: order, origin, link: null, email,
    });
    return { status: 200, body: { needs_manual_issue: true, reference, reason: 'currency_mismatch' } };
  }

  if (!isEmail(email) || !entity) {
    await notifyOperator(env, {
      problem: !entity
        ? 'Paystack order paid but carries no licensee entity (form bypassed, or the order expired from KV).'
        : 'Paystack order paid but carries no payer email.',
      reference, txn, custom: order, origin, link: null, email: email || null,
    });
    return {
      status: 200,
      body: { needs_manual_issue: true, reference, reason: !entity ? 'no_licensee_entity' : 'no_payer_email' },
    };
  }

  const issued = String(txn.paid_at ?? new Date().toISOString()).slice(0, 10);
  const doc = buildLicence(env, { entity, email, reference, issued });
  const token = randomToken();
  const link = `${origin}/licence/${token}`;

  // Same order as the Paddle path: document, buyer email, then the idempotency key. A crash between them
  // re-issues visibly rather than silently doing nothing.
  await env.LICENCES.put(`lic:${token}`, JSON.stringify({
    reference, entity, email, transaction: txn.id ?? reference, issued,
    created: new Date().toISOString(), doc, rail: 'paystack',
    attribution: order.attribution ?? readAttribution({}),
  }));

  await sendBuyerEmail(env, { email, entity, reference, link });
  await env.LICENCES.put(paidKey, token);
  await notifyOperator(env, { problem: null, reference, txn, custom: order, origin, link, entity, email });

  return { status: 200, body: { issued: true, reference, link } };
}

/**
 * Verify Paystack's webhook signature, handling BOTH shapes an account may present.
 *
 * The classic scheme is a bare hex HMAC-SHA512 of the raw body keyed by the secret key, which is what most
 * SDKs implement. Paystack's current documentation instead describes a timestamped `t=…,v1=<key id>:<sig>`
 * form with `whk_`-prefixed key ids. Which arrives depends on whether a signing secret has been rolled out
 * to the account, so this reads what actually arrives rather than assuming.
 */
async function verifyPaystackSignature(secret, header, body, nowMs = Date.now()) {
  if (!secret) return { ok: false, reason: 'no_secret_configured' };
  if (!header) return { ok: false, reason: 'missing_header' };

  const fields = new Map();
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq !== -1) fields.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }

  if (fields.has('v1')) {
    const timestamp = fields.get('t');
    const signed = timestamp ? `${timestamp}.${body}` : body;
    const expected = await hmacSha512Hex(secret, signed);
    for (const [key, value] of fields) {
      if (key !== 'v1') continue;
      const signature = value.includes(':') ? value.slice(value.indexOf(':') + 1) : value;
      if (!timingSafeEqualHex(expected, signature.toLowerCase())) continue;
      if (timestamp && Math.abs(Math.floor(nowMs / 1000) - Number(timestamp)) > SIGNATURE_TOLERANCE_SECONDS * 12) {
        // Generous: this arm is documented but has not been observed on this account yet, so a tight window
        // would reject valid events the day it starts being used. Tightened once one is captured.
        return { ok: false, reason: 'stale_timestamp' };
      }
      return { ok: true, scheme: 'timestamped' };
    }
    return { ok: false, reason: 'signature_mismatch' };
  }

  const expected = await hmacSha512Hex(secret, body);
  return timingSafeEqualHex(expected, header.trim().toLowerCase())
    ? { ok: true, scheme: 'classic' }
    : { ok: false, reason: 'signature_mismatch' };
}

async function hmacSha512Hex(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-512' }, false, ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function fetchCustomerEmail(env, customerId) {
  if (!env.PADDLE_API_KEY) return { ok: false, reason: 'server_missing_paddle_api_key' };
  if (!/^ctm_[a-z\d]{26}$/u.test(String(customerId ?? ''))) {
    return { ok: false, reason: `unusable_customer_id:${customerId ?? '(none)'}` };
  }
  try {
    const res = await fetch(`${env.PADDLE_API_BASE ?? 'https://api.paddle.com'}/customers/${customerId}`, {
      headers: {
        authorization: `Bearer ${env.PADDLE_API_KEY}`,
        'paddle-version': '1',
      },
    });
    if (!res.ok) return { ok: false, reason: `paddle_customer_lookup_${res.status}` };
    const body = await res.json();
    const email = String(body?.data?.email ?? '').trim();
    if (!isEmail(email)) return { ok: false, reason: 'paddle_customer_has_no_usable_email' };
    return { ok: true, email };
  } catch (error) {
    return { ok: false, reason: `paddle_customer_lookup_failed:${error?.message ?? 'unknown'}` };
  }
}

/* ─────────────────────────────────────────────────────────────────────── signature ── */
/**
 * `Paddle-Signature: ts=1671552777;h1=eb4d0dc8…` — HMAC-SHA256 over `${ts}:${rawBody}`.
 * The timestamp is checked too: without it a captured request could be replayed forever.
 */
async function verifySignature(secret, header, body, nowMs) {
  if (!secret) return { ok: false, reason: 'server_missing_webhook_secret' };
  if (!header) return { ok: false, reason: 'missing_signature_header' };

  const parts = new Map();
  for (const bit of header.split(';')) {
    const eq = bit.indexOf('=');
    if (eq > 0) parts.set(bit.slice(0, eq).trim().toLowerCase(), bit.slice(eq + 1).trim());
  }
  const ts = parts.get('ts');
  const h1 = parts.get('h1');
  if (!ts || !h1) return { ok: false, reason: 'malformed_signature_header' };

  const skew = Math.abs(nowMs / 1000 - Number(ts));
  if (!Number.isFinite(skew) || skew > SIGNATURE_TOLERANCE_SECONDS) {
    return { ok: false, reason: 'timestamp_outside_tolerance' };
  }

  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${ts}:${body}`));
  const expected = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');

  return timingSafeEqualHex(expected, h1.toLowerCase())
    ? { ok: true, reason: null }
    : { ok: false, reason: 'signature_mismatch' };
}

/** Length-independent-ish comparison; never early-returns on the first differing character. */
function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ──────────────────────────────────────────────────────────────────── the document ── */

/**
 * Mirrors `tools/issue-licence.py` byte for byte in structure and wording, so a licence issued here
 * and one issued locally describe the same grant. If you change one, change both — the local script
 * is the reference implementation and can regenerate any delivered document for verification.
 */
function buildLicence(env, { entity, email, reference, issued }) {
  const version = env.ARTIFACT_VERSION;
  const sha = env.ARTIFACT_SHA256;
  return `# Commercial licence — dsh-media-reader ${version}

**Licensor:** Itikia Digital Solutions, Nairobi, Kenya
**Licensee:** ${entity} (${email})
**Order / invoice reference:** ${reference}
**Issued:** ${issued}
**Covers this artifact exactly:** \`dsh-media-reader-${version}.tar.gz\`
**sha256:** \`${sha}\`

## What is granted

A non-exclusive, non-transferable, perpetual licence to **use** dsh-media-reader ${version} for commercial
purposes, including inside a company's internal revenue-earning workflow and as a component of a product or
paid service the Licensee delivers. This includes updates published within **12 months** of the issue date.

One licence covers one team: every machine that team uses, not other companies.

## What is not granted

- **No redistribution.** The Licensee may not publish, sublicense, sell or give away the plugin, the bundle or
  a derivative of them, in whole or in substantial part.
- **No competing product.** The Licensee may not use it to build a product whose primary purpose is to replace
  it.
- **No removal of notices.** The copyright and licence notices must remain intact.

## Terms that travel with the artifact

The full terms are the \`LICENSE\` file inside the bundle; where this document and that file differ, that file
governs. Third-party components keep their own licences (ffmpeg, faster-whisper and its model weights, and the
DeepSeek Harness packages) and are unaffected by this grant.

## Verification

The artifact covered is identified by the sha256 above. \`MANIFEST.json\` inside it lists every file with its own
hash, so the Licensee can confirm that what they received is what this licence covers.

---

**Issued by:** Samora Chumbi, Itikia Digital Solutions  **Date:** ${issued}
Itikia Digital Solutions · samora@itikia.co.ke · ${env.STORE_URL}
`;
}

async function serveLicence(url, env, method = 'GET') {
  const token = url.pathname.slice('/licence/'.length);
  const raw = await env.LICENCES.get(`lic:${token}`);
  if (!raw) return json({ error: 'not_found' }, 404, method);

  const record = JSON.parse(raw);
  // HEAD carries the same status and headers with no body, so a prober sees exactly what a fetcher sees.
  return new Response(method === 'HEAD' ? null : record.doc, {
    headers: {
      'content-type': 'text/markdown; charset=utf-8',
      'content-disposition': `attachment; filename="dsh-media-reader-licence-${record.reference}.md"`,
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow',
    },
  });
}

/* ────────────────────────────────────────────────────────────────────────── emails ── */

async function sendBuyerEmail(env, { email, entity, reference, link }) {
  const version = env.ARTIFACT_VERSION;
  const sha = env.ARTIFACT_SHA256;
  const subject = `Your dsh-media-reader commercial licence — ${reference}`;

  const text = `Hello,

Your commercial licence for dsh-media-reader ${version} is issued to ${entity}.

Download your licence: ${link}
Order / invoice reference: ${reference}

The plugin itself: ${env.ARTIFACT_URL}
sha256: ${sha}

Check that hash before you install — it should match the .sha256 file published beside the bundle. The licence names that exact hash, so a mismatched download is not covered by it.

Paddle, as merchant of record, has already emailed your tax invoice separately.

If anything looks wrong, reply to this message or write to samora@itikia.co.ke and quote ${reference}.

— Samora Chumbi
Itikia Digital Solutions
${env.STORE_URL}
`;

  const html = `<p>Hello,</p>
<p>Your commercial licence for <strong>dsh-media-reader ${escapeHtml(version)}</strong> is issued to
<strong>${escapeHtml(entity)}</strong>.</p>
<p><a href="${link}" style="display:inline-block;padding:11px 18px;background:#1d4ed8;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">Download your licence</a></p>
<p>Order / invoice reference: <strong>${escapeHtml(reference)}</strong></p>
<p>The plugin itself: <a href="${env.ARTIFACT_URL}">${escapeHtml(env.ARTIFACT_URL)}</a><br>
<code>sha256: ${escapeHtml(sha)}</code></p>
<p>Check that hash before you install — it should match the <code>.sha256</code> file published beside the
bundle. The licence names that exact hash, so a mismatched download is not covered by it.</p>
<p>Paddle, as merchant of record, has already emailed your tax invoice separately.</p>
<p>If anything looks wrong, reply to this message or write to
<a href="mailto:samora@itikia.co.ke">samora@itikia.co.ke</a> and quote ${escapeHtml(reference)}.</p>
<p>— Samora Chumbi<br>Itikia Digital Solutions<br><a href="${env.STORE_URL}">${escapeHtml(env.STORE_URL)}</a></p>
`;

  await env.EMAIL.send({ to: email, from: env.FROM_EMAIL, subject, text, html });
}

async function notifyOperator(env, { problem, reference, txn, custom, origin, link, entity, email }) {
  const totals = txn?.details?.totals ?? {};
  const money = `${(Number(totals.total ?? 0) / 100).toFixed(2)} ${totals.currency_code ?? '?'}`;
  const subject = problem
    ? `ACTION NEEDED — ${reference} paid, licence NOT issued`
    : `Licence issued — ${entity} — ${reference}`;

  const rows = [
    ['Reference', reference],
    ['Transaction', txn?.id ?? '(none)'],
    ['Amount', money],
    ['Channel', channelLine(readAttribution(custom))],
    ['Licensee', entity ?? custom?.licensee_entity ?? '(none)'],
    ['Delivery email', email ?? custom?.buyer_email ?? '(none)'],
    ['Licence link', link ?? '(not issued)'],
  ];
  const body = rows.map(([k, v]) => `${k}: ${v}`).join('\n')
    + (problem ? `\n\nProblem: ${problem}\n\nThe licence was NOT issued. Issue it by hand with:\n`
        + `  python3 tools/issue-licence.py --buyer "<entity>" --email "<email>" --order "${reference}"` : '');

  await env.EMAIL.send({
    to: env.OPERATOR_EMAIL,
    from: env.FROM_EMAIL,
    subject,
    text: body,
    html: `<h2>${escapeHtml(subject)}</h2>
<table cellpadding="6" style="border-collapse:collapse">
${rows.map(([k, v]) => `<tr><td style="color:#555">${escapeHtml(k)}</td><td><strong>${escapeHtml(String(v))}</strong></td></tr>`).join('')}
</table>
${problem ? `<p style="color:#b42318"><strong>Problem:</strong> ${escapeHtml(problem)}</p>
<pre>python3 tools/issue-licence.py --buyer "&lt;entity&gt;" --email "&lt;email&gt;" --order "${escapeHtml(reference)}"</pre>` : ''}`,
  });
}

/* ───────────────────────────────────────────────────────────────────────── helpers ── */

/**
 * Purchase attribution — sanitise the campaign tags the storefront put on the transaction.
 *
 * Same character class and caps as the storefront, applied a second time here because the browser is
 * not a trustworthy source. Absent tags become `unknown` rather than empty, so the operator email never
 * shows a blank channel and an old order (placed before attribution existed) reads honestly.
 */
const UTM_LIMITS = Object.freeze({ utm_source: 40, utm_medium: 40, utm_campaign: 60, utm_content: 40 });

function readAttribution(custom) {
  const tags = {};
  for (const [key, max] of Object.entries(UTM_LIMITS)) {
    const clean = String(custom?.[key] ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9_.-]+/gu, '-')
      .replace(/^[-.]+|[-.]+$/gu, '')
      .slice(0, max);
    if (clean) tags[key] = clean;
  }
  if (!tags.utm_source) tags.utm_source = 'unknown';
  return tags;
}

/** One readable line for the operator email: `github / repo / discovery_repair`. */
function channelLine(attribution) {
  const parts = [attribution.utm_source];
  for (const key of ['utm_medium', 'utm_campaign', 'utm_content']) {
    if (attribution[key]) parts.push(attribution[key]);
  }
  return parts.join(' / ');
}

function randomToken() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function isEmail(value) {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(value);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/gu, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function json(payload, status, method = 'GET') {
  // HEAD must not carry a body, but it must carry the same status and headers.
  return new Response(method === 'HEAD' ? null : JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
