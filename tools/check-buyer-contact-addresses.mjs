#!/usr/bin/env node
/**
 * check-buyer-contact-addresses.mjs — no buyer-facing document may name an address that cannot receive.
 *
 * WHY THIS EXISTS
 * Every licence this product issues ends with a line naming a human to write to, and the licence email says
 * the same thing twice more. On 2026-11-24 five licences went out telling buyers to write to
 * `samora@itikia.co.ke`, and **no routing rule existed for it** — the catch-all was disabled. A paying
 * customer's only route to support was a dead address, printed on a legal document, and nothing in the
 * build, the test suite or the deploy could see it: the address is a string in a template, and the mail
 * configuration lives in Cloudflare.
 *
 * So: read every address the product writes into buyer-facing text, then read the live routing
 * configuration, and refuse if any of them cannot receive.
 *
 *   node tools/check-buyer-contact-addresses.mjs            # live check
 *   node tools/check-buyer-contact-addresses.mjs --self-test  # prove the check bites
 *
 * The check is deliberately conservative: an address passes only if an ENABLED rule matches it and forwards
 * to a VERIFIED destination, or if the catch-all is enabled and forwards. Anything else is a dead address,
 * because "probably routed" is how this went wrong the first time.
 *
 * RE-POINT THIS IF MX MOVES. It reads Cloudflare's routing config, so the day this domain's mail is hosted
 * elsewhere (Zoho, Google, Fastmail) Cloudflare stops receiving and this check would report a green that is
 * no longer about anything. Re-point it at that provider's address list before switching MX, not after.
 */
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

const REPO = new URL('..', import.meta.url)
const read = (path) => readFile(new URL(path, REPO), 'utf8')
const SELF_TEST = process.argv.includes('--self-test')

/* ── the addresses the product tells buyers to use ─────────────────────────────────────────────── */

const SOURCES = ['worker/licence/src/index.js', 'tools/issue-licence.py', 'worker/licence/wrangler.jsonc']

async function buyerFacingAddresses() {
  const found = new Map() // address -> Set(files)
  for (const source of SOURCES) {
    let text
    try {
      text = await read(source)
    } catch {
      continue // a source may not exist in a given checkout; the live check still runs on the rest
    }
    for (const match of text.matchAll(/[a-z0-9._%+-]+@itikia\.co\.ke/giu)) {
      const address = match[0].toLowerCase()
      if (!found.has(address)) found.set(address, new Set())
      found.get(address).add(source)
    }
  }
  return found
}

/* ── the live Cloudflare routing configuration (read-only) ─────────────────────────────────────── */

function wranglerToken() {
  const path = join(homedir(), '.config', '.wrangler', 'config', 'default.toml')
  const result = spawnSync('cat', [path], { encoding: 'utf8' })
  if (result.status !== 0) return null
  const match = /oauth_token\s*=\s*"([^"]+)"/u.exec(result.stdout)
  return match ? match[1] : null
}

async function cloudflareGet(path, token) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  })
  const body = await response.json()
  if (!body.success) throw new Error(`${path}: ${JSON.stringify(body.errors ?? body).slice(0, 200)}`)
  return body.result
}

async function liveConfig(domain) {
  const token = wranglerToken()
  if (!token) throw new Error('no wrangler OAuth token at ~/.config/.wrangler/config/default.toml — run `wrangler login`')
  const zones = await cloudflareGet(`/zones?name=${domain}`, token)
  if (!zones.length) throw new Error(`zone ${domain} not found in this Cloudflare account`)
  const zone = zones[0]
  const accountId = zone.account.id
  const [rules, destinations, catchAll] = await Promise.all([
    cloudflareGet(`/accounts/${accountId}/email/routing/rules`, token),
    cloudflareGet(`/accounts/${accountId}/email/routing/addresses`, token),
    cloudflareGet(`/accounts/${accountId}/email/routing/rules/catch_all`, token).catch(() => null),
  ])
  return {
    zoneId: zone.id,
    rules,
    verified: new Set(destinations.filter((d) => d.verified).map((d) => d.email.toLowerCase())),
    catchAll: catchAll ?? rules.find((r) => (r.matchers ?? []).some((m) => m.type === 'all')) ?? null,
  }
}

/* ── the rule that decides dead or alive ──────────────────────────────────────────────────────── */

function verdict(address, config) {
  const forwardsToVerified = (rule) =>
    rule.enabled !== false &&
    (rule.actions ?? []).some(
      (action) => action.type === 'forward' && (action.value ?? []).some((to) => config.verified.has(String(to).toLowerCase())),
    )

  const literal = config.rules.find(
    (rule) =>
      forwardsToVerified(rule) &&
      (rule.matchers ?? []).some((m) => m.field === 'to' && m.type === 'literal' && String(m.value).toLowerCase() === address),
  )
  if (literal) return { ok: true, why: 'an enabled rule forwards it to a verified destination' }

  const catchAllForwards = config.catchAll
    ? forwardsToVerified(config.catchAll) && (config.catchAll.enabled ?? true) !== false
    : false
  if (catchAllForwards) return { ok: true, why: 'the catch-all forwards everything to a verified destination' }

  return { ok: false, why: 'no enabled rule matches it and the catch-all does not forward — mail to it is lost' }
}

/* ── self-test: the check must fail on the exact defect it exists for ─────────────────────────── */

const VERIFIED = new Set(['owner@example.com'])
const fixture = (overrides = {}) => ({
  zoneId: 'test',
  verified: VERIFIED,
  rules: [],
  catchAll: null,
  ...overrides,
})

const CASES = [
  {
    name: 'the 2026-11-24 defect: no rule for the address, catch-all disabled',
    config: fixture(),
    address: 'samora@itikia.co.ke',
    expectOk: false,
  },
  {
    name: 'a literal rule forwarding to a verified destination',
    config: fixture({
      rules: [{ enabled: true, matchers: [{ field: 'to', type: 'literal', value: 'samora@itikia.co.ke' }], actions: [{ type: 'forward', value: ['owner@example.com'] }] }],
    }),
    address: 'samora@itikia.co.ke',
    expectOk: true,
  },
  {
    name: 'an enabled catch-all that forwards',
    config: fixture({ catchAll: { enabled: true, actions: [{ type: 'forward', value: ['owner@example.com'] }] } }),
    address: 'anything@itikia.co.ke',
    expectOk: true,
  },
  {
    name: 'a rule that forwards to an UNVERIFIED destination',
    config: fixture({
      rules: [{ enabled: true, matchers: [{ field: 'to', type: 'literal', value: 'hello@itikia.co.ke' }], actions: [{ type: 'forward', value: ['nobody@example.com'] }] }],
    }),
    address: 'hello@itikia.co.ke',
    expectOk: false,
  },
  {
    name: 'a DISABLED rule for the address',
    config: fixture({
      rules: [{ enabled: false, matchers: [{ field: 'to', type: 'literal', value: 'hello@itikia.co.ke' }], actions: [{ type: 'forward', value: ['owner@example.com'] }] }],
    }),
    address: 'hello@itikia.co.ke',
    expectOk: false,
  },
  {
    name: 'a catch-all that DROPS instead of forwarding',
    config: fixture({ catchAll: { enabled: true, actions: [{ type: 'drop' }] } }),
    address: 'support@itikia.co.ke',
    expectOk: false,
  },
]

if (SELF_TEST) {
  let failed = 0
  for (const testCase of CASES) {
    const result = verdict(testCase.address, testCase.config)
    const pass = result.ok === testCase.expectOk
    if (!pass) failed += 1
    console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${testCase.name}`)
    if (!pass) console.log(`        expected ok=${testCase.expectOk}, got ok=${result.ok} (${result.why})`)
  }
  console.log(`\n${CASES.length - failed}/${CASES.length} self-test cases behave as stated`)
  process.exitCode = failed === 0 ? 0 : 1
} else {
  const addresses = await buyerFacingAddresses()
  if (addresses.size === 0) {
    console.error('REFUSING: found no @itikia.co.ke address in the product sources — the check would be vacuous')
    process.exitCode = 1
  } else {
    const config = await liveConfig('itikia.co.ke')
    console.log(`live routing for itikia.co.ke — ${config.rules.length} rule(s), catch-all ${config.catchAll?.enabled === false ? 'disabled' : config.catchAll ? 'enabled' : 'absent'}, ${config.verified.size} verified destination(s)\n`)
    let dead = 0
    for (const address of [...addresses.keys()].sort()) {
      const result = verdict(address, config)
      if (!result.ok) dead += 1
      console.log(`  ${result.ok ? 'PASS' : 'DEAD'}  ${address.padEnd(26)} ${result.why}`)
      console.log(`        named in: ${[...addresses.get(address)].join(', ')}`)
    }
    console.log('')
    if (dead > 0) {
      console.error(`${dead} buyer-facing address(es) cannot receive mail. A paying customer is being told to write to a dead address.`)
      console.error('Fix with: npx wrangler email routing rules create itikia.co.ke --match-type literal --match-field to \\')
      console.error('            --match-value <address> --action-type forward --action-value <verified address> --enabled')
      process.exitCode = 1
    } else {
      console.log('every buyer-facing address the product prints can receive mail')
    }
  }
}
