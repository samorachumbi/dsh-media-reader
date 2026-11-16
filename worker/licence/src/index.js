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
    if (request.method === 'GET' && TOKEN_PATTERN.test(url.pathname.slice('/licence/'.length)) &&
        url.pathname.startsWith('/licence/')) {
      return serveLicence(url, env);
    }
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      return json({ ok: true, service: 'dsh-media-reader licence issuer', artifact: env.ARTIFACT_VERSION }, 200);
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
  const entity = String(custom.licensee_entity ?? '').trim();
  const email = String(custom.buyer_email ?? '').trim();
  const reference = String(txn.invoice_number ?? txn.id);
  const issued = String(txn.billed_at ?? new Date().toISOString()).slice(0, 10);
  const origin = new URL(request.url).origin;

  // Rule 3: never issue a licence that names nobody.
  if (!entity || !isEmail(email)) {
    await notifyOperator(env, {
      problem: !entity
        ? 'Order paid but carries no licensee entity (the checkout form was bypassed or predates it).'
        : `Order paid but the delivery address is not a usable email: ${email || '(empty)'}`,
      reference, txn, custom, origin, link: null,
    });
    return json({ needs_manual_issue: true, reference }, 200);
  }

  const doc = buildLicence(env, { entity, email, reference, issued });
  const token = randomToken();
  const link = `${origin}/licence/${token}`;

  // Store the document, then the idempotency key. If the second write fails the buyer has already
  // been emailed, and a retry re-issues — visibly, to the operator — rather than silently nothing.
  await env.LICENCES.put(`lic:${token}`, JSON.stringify({
    reference, entity, email, transaction: txn.id, issued, created: new Date().toISOString(), doc,
  }));

  await sendBuyerEmail(env, { email, entity, reference, link, issued });
  await env.LICENCES.put(orderKey, token);
  await notifyOperator(env, { problem: null, reference, txn, custom, origin, link, entity, email });

  return json({ issued: true, reference, link }, 200);
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

async function serveLicence(url, env) {
  const token = url.pathname.slice('/licence/'.length);
  const raw = await env.LICENCES.get(`lic:${token}`);
  if (!raw) return json({ error: 'not_found' }, 404);

  const record = JSON.parse(raw);
  return new Response(record.doc, {
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

function json(payload, status) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
