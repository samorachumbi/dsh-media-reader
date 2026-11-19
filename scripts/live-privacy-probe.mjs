#!/usr/bin/env node
/**
 * Live privacy probe — fails when the deployed response disagrees with the published policy.
 *
 * THE DEFECT THIS EXISTS FOR (B3, measured 2026-11-19)
 * The privacy page said the site "sets no cookies, runs no analytics and has no trackers", while
 * Cloudflare injected static.cloudflareinsights.com/beacon.min.js into every HTML response at the
 * edge. A scan of the source tree could not see it: the file that served the promise was not the
 * file that broke it.
 *
 * THE TRAP THAT MAKES THIS PROBE NECESSARY *AND* DANGEROUS
 * Cloudflare injects that beacon only when the request declares `Accept: text/html`. A probe that
 * omits the header — or sends `Accept: * / *` — receives a clean page and reports a pass while a real
 * browser receives the beacon. That is not hypothetical: it produced a false PASS in this repository
 * on 2026-11-19, minutes before the same URL reported the beacon with the header added. The
 * Accept header below is load-bearing and is asserted by tests/storefront-privacy.test.mjs.
 *
 * WHY IT SELF-TESTS FIRST
 * A guard that cannot fail on the real defect is not a guard. Before touching the network this probe
 * runs its own detector against a captured response that provably contains the beacon
 * (tests/fixtures/cloudflare-beacon-response.html). If the detector fails to find it there, the probe
 * aborts with exit 2 rather than reporting a pass it has not earned.
 *
 * Usage:
 *   node scripts/live-privacy-probe.mjs
 *   PROBE_BASE=https://preview.example node scripts/live-privacy-probe.mjs
 *
 * Exit codes: 0 agree · 1 disagree · 2 probe could not be trusted (self-test or fetch failed).
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const repo = new URL('..', import.meta.url)
const BASE = process.env.PROBE_BASE ?? 'https://store.itikia.co.ke'
const PAGES = ['/', '/privacy', '/pricing', '/terms', '/refund']

/** Hosts that must never be a loaded resource on a site whose policy forbids analytics and trackers. */
const FORBIDDEN_HOSTS = [
  'static.cloudflareinsights.com',
  'cloudflareinsights.com',
  'www.googletagmanager.com',
  'www.google-analytics.com',
  'google-analytics.com',
  'connect.facebook.net',
  'analytics.tiktok.com',
  'cdn.segment.com',
  'js.hs-scripts.com',
  'plausible.io',
  'cdn.mxpnl.com',
  'static.hotjar.com',
  'clarity.ms',
  'sc-static.net',
]

/**
 * LOAD-BEARING. Cloudflare skips beacon injection without `Accept: text/html`.
 * Do not remove or "simplify" this. tests/storefront-privacy.test.mjs fails if it disappears.
 */
const BROWSER_HEADERS = Object.freeze({
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
  'User-Agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
})

/**
 * Every host the document would actually fetch as script, style or font.
 * Deliberately ignores <a href> — an outbound link is not a loaded resource.
 */
export function loadedThirdPartyHosts(html) {
  const hosts = new Set()
  const pattern = /<(script|link|iframe|img)\b[^>]*?\b(?:src|href)\s*=\s*["'](https?:\/\/[^"']+)["']/giu
  for (const match of html.matchAll(pattern)) {
    try {
      hosts.add(new URL(match[2]).host)
    } catch {
      /* malformed URL: not a resource we can attribute */
    }
  }
  return [...hosts]
}

/** Forbidden hosts that the document would actually load. Empty array means clean. */
export function findForbiddenLoads(html, forbidden = FORBIDDEN_HOSTS) {
  const loaded = loadedThirdPartyHosts(html)
  const banned = new Set(forbidden.map((host) => host.toLowerCase()))
  return loaded.filter((host) => banned.has(host.toLowerCase()))
}

async function selfTest() {
  const fixture = await readFile(new URL('tests/fixtures/cloudflare-beacon-response.html', repo), 'utf8')
  const found = findForbiddenLoads(fixture)
  if (!found.includes('static.cloudflareinsights.com')) {
    throw new Error(
      'SELF-TEST FAILED: the detector could not find the beacon in the captured response. ' +
        'It cannot be trusted to report a pass on the live site.',
    )
  }
  return true
}

async function fetchPage(path) {
  const url = `${BASE}${path}`
  const response = await fetch(url, { headers: BROWSER_HEADERS, redirect: 'follow' })
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`)
  return { url, html: await response.text() }
}

async function main() {
  console.log(`live privacy probe — ${BASE}`)
  console.log(`header sent: Accept: ${BROWSER_HEADERS.Accept}   (load-bearing)`)

  try {
    await selfTest()
    console.log('  self-test   PASS — detector finds the beacon in the captured response')
  } catch (error) {
    console.error(`  self-test   FAIL — ${error.message}`)
    process.exit(2)
  }

  const failures = []
  for (const path of PAGES) {
    let page
    try {
      page = await fetchPage(path)
    } catch (error) {
      console.error(`  ${path.padEnd(10)} ERROR — ${error.message}`)
      failures.push(`${path}: fetch failed`)
      continue
    }
    const offenders = findForbiddenLoads(page.html)
    if (offenders.length === 0) {
      console.log(`  ${path.padEnd(10)} clean`)
    } else {
      console.error(`  ${path.padEnd(10)} FAIL — loads ${offenders.join(', ')}`)
      failures.push(`${path}: loads ${offenders.join(', ')}`)
    }
  }

  // The policy and the response must agree, not merely both exist.
  const privacy = PAGES.includes('/privacy') ? await fetchPage('/privacy').catch(() => null) : null
  if (privacy) {
    const claimsNoAnalytics = /no analytics/iu.test(privacy.html)
    const claimsNoTrackers = /no trackers/iu.test(privacy.html)
    if (!claimsNoAnalytics || !claimsNoTrackers) {
      console.error('  policy      FAIL — the privacy page no longer states the claim this probe enforces')
      failures.push('privacy page no longer makes the no-analytics claim; update the probe and the policy together')
    } else {
      console.log('  policy      states "no analytics" and "no trackers" — enforcement matches the promise')
    }
  }

  if (failures.length > 0) {
    console.error(`\nVERDICT: DISAGREE (${failures.length})`)
    for (const failure of failures) console.error(`  - ${failure}`)
    process.exit(1)
  }
  console.log('\nVERDICT: the live responses agree with the published policy.')
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`probe could not complete: ${error.message}`)
    process.exit(2)
  })
}
