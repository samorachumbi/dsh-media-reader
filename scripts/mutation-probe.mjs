#!/usr/bin/env node
/**
 * mutation-probe.mjs — L3: "mutation-test: change a price in one source and require the guard to name the
 * disagreement".
 *
 * The standing rule here is that a guard is only a guard once it has been shown to fail on the exact defect. Doing
 * that by hand works exactly once per session and is remembered by nobody, so the mutations live in this file and are
 * re-run on demand. Each entry reintroduces one defect, and the probe requires that the suite FAILS for the stated
 * reason — a mutation that leaves the suite green is a toothless guard, and the probe exits non-zero to say so.
 *
 * It never touches the working tree: every mutation is applied to a throwaway copy.
 *
 *   node scripts/mutation-probe.mjs              # the storefront guard subset (fast)
 *   node scripts/mutation-probe.mjs --full       # the whole suite per mutation (slower, same verdicts expected)
 *   node scripts/mutation-probe.mjs --list       # show the mutations without running them
 *   node scripts/mutation-probe.mjs --only price # run the mutations whose name matches
 */
import { cp, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const argv = process.argv.slice(2)
const has = (name) => argv.includes(name)
const valueOf = (name) => {
  const index = argv.indexOf(name)
  return index === -1 ? null : argv[index + 1] ?? null
}

/**
 * Each mutation: the defect to reintroduce, and the words the suite must fail with.
 * `expect` is deliberately specific — a mutation that fails for an unrelated reason proves nothing.
 */
const MUTATIONS = [
  {
    name: 'price-usd-drift',
    what: 'the configured USD price moves and the Product does not follow',
    file: 'store/index.html',
    replace: ['"usd": 79', '"usd": 89'],
    expect: /disagrees with #pay-config price\.usd/,
  },
  {
    name: 'cny-offer-currency',
    what: 'a China offer is relabelled as a currency the processor cannot charge',
    file: 'store/pricing.html',
    replace: ['"priceCurrency": "CNY"', '"priceCurrency": "KES"'],
    expect: /publishes a KES Offer but no live rail charges shillings|a CNY offer is required/,
  },
  {
    name: 'refund-window-drift',
    what: 'the refund page promises a longer window than the structured policy',
    // The visible sentence, not the meta description: the first version of this mutation edited a literal that only
    // appeared inside the meta tag, which the guards strip, so it changed nothing any guard reads and "survived".
    file: 'store/refund.html',
    replace: ['within <strong>14 days of purchase</strong>', 'within <strong>30 days of purchase</strong>'],
    expect: /refund\.html says 30 days but #pay-config says 14|disagrees with the refund page/,
  },
  {
    name: 'refund-meta-drift',
    what: 'the refund window changes only in the sentence a search result shows',
    file: 'store/refund.html',
    replace: ['Refunds within 14 days of purchase', 'Refunds within 30 days of purchase'],
    expect: /meta description says 30 days but #pay-config says 14/,
  },
  {
    name: 'canonical-removed',
    what: 'the homepage loses its canonical URL',
    file: 'store/index.html',
    replace: ['  <link rel="canonical" href="https://store.itikia.co.ke/">\n', ''],
    expect: /exactly one canonical|must declare exactly one canonical/,
  },
  {
    name: 'contact-swapped',
    what: 'the machine-readable contact reverts to the issuer personal address',
    file: 'store/index.html',
    replace: ['"email": "hello@itikia.co.ke"', '"email": "samora@itikia.co.ke"'],
    expect: /canonical published address/,
  },
  {
    name: 'updates-months-drift',
    what: 'llms.txt promises a longer update period than the licence gives',
    file: 'store/llms.txt',
    replace: ['12 months of updates', '24 months of updates'],
    expect: /llms\.txt says 24 months of updates but #pay-config says 12/,
  },
  {
    name: 'product-months-drift',
    what: 'the structured Product states a different update period from the config',
    file: 'store/pricing.html',
    replace: ['12 months of updates', '6 months of updates'],
    expect: /must state 12 months of updates/,
  },
  {
    name: 'bundle-file-tampered',
    what: 'a shipped file no longer matches the hash its manifest publishes',
    file: 'dist-tools/bundle/dsh-media-reader-0.1.2/LICENSE',
    replace: [null, '\n'],
    expect: /do not match their manifest hash/,
  },
  {
    name: 'file-count-claim',
    what: 'the sales page claims a file count the manifest contradicts',
    file: 'store/index.html',
    replace: ['<b>78 files</b>', '<b>76 files</b>'],
    expect: /must claim 78 files/,
  },
  {
    name: 'whitelist-drops-robots',
    what: 'robots.txt is left off the deploy whitelist, so it never ships',
    file: 'tools/deploy-store.sh',
    replace: [' llms.txt robots.txt assets)', ' llms.txt assets)'],
    expect: /would never ship/,
  },
  {
    name: 'amount-sent-in-major-units',
    what: 'the Worker charges 10000 instead of 1000000 minor units — a 100x underpricing',
    file: 'worker/licence/src/index.js',
    replace: ['const PAYSTACK_AMOUNT_MINOR_DEFAULT = 1000000;', 'const PAYSTACK_AMOUNT_MINOR_DEFAULT = 10000;'],
    expect: /sells the licence for one hundredth/,
  },
  {
    name: 'trusts-the-callback-amount',
    what: 'the Worker stops re-reading the amount from Paystack and believes the webhook body',
    file: 'worker/licence/src/index.js',
    replace: ['if (Number(txn.amount) !== expected) {', 'if (false) {'],
    expect: /must not issue a KSh 10,000 licence/,
  },
  {
    name: 'webhook-signature-not-checked',
    what: 'the webhook handler accepts any body instead of verifying the signature',
    file: 'worker/licence/src/index.js',
    replace: ["  if (!check.ok) {\n    console.warn('rejected paystack webhook:', check.reason);", "  if (false) {\n    console.warn('rejected paystack webhook:', check.reason);"],
    expect: /must be refused with 401|must not even trigger a verify call/,
  },
  {
    name: 'no-user-agent-on-paystack-calls',
    what: 'Paystack calls go out without a User-Agent, which Cloudflare answers with 403/1010',
    file: 'worker/licence/src/index.js',
    replace: ["      'user-agent': 'dsh-media-reader-licence/1.0 (+https://store.itikia.co.ke)',\n", ''],
    expect: /Cloudflare's bot filter with 403 error 1010/,
  },
  {
    name: 'kes-hedge-removed',
    what: 'the page stops saying shillings are not yet chargeable while the Kenya rail is dark',
    file: 'store/llms.txt',
    replace: ['no rail charges', 'shillings are charged'],
    expect: /must say shillings are not charged yet/,
  },
  {
    name: 'kes-offer-without-a-live-rail',
    what: 'a KES Offer appears while no rail can charge shillings',
    file: 'store/pricing.html',
    replace: ['"priceCurrency": "CNY"', '"priceCurrency": "KES"'],
    expect: /publishes a KES Offer but no live rail charges shillings/,
  },
  {
    name: 'rail-charges-undeclared',
    what: 'a rail stops declaring the currency it charges',
    file: 'store/index.html',
    replace: ['"charges": "KES",', ''],
    expect: /must declare the currency it charges in/,
  },
  {
    name: 'whitelist-drops-a-verifier-page',
    what: 'a page the live verifier checks stops being published',
    file: 'tools/deploy-store.sh',
    replace: [' privacy.html', ''],
    expect: /the verifier fetches paths the deploy never publishes/,
  },
  {
    name: 'preflight-narrowed',
    what: 'the pre-deploy gate runs one guard file instead of the suite',
    file: 'tools/deploy-store.sh',
    replace: ['node --test tests/storefront-*.test.mjs', 'node --test tests/storefront-rails.test.mjs'],
    expect: /single guard file is not the storefront guard set/,
  },
  {
    name: 'whitelist-names-missing-file',
    what: 'the deploy whitelist lists a file the site does not have',
    file: 'tools/deploy-store.sh',
    replace: [' llms.txt robots.txt assets)', ' llms.txt robots.txt missing-page.html assets)'],
    expect: /names files that do not exist/,
  },
  {
    name: 'llms-cny-drift',
    what: 'the agent facts file states a China price the page does not charge',
    file: 'store/llms.txt',
    replace: ['\u00a5560', '\u00a5580'],
    expect: /llms\.txt says \u00a5580/,
  },
  {
    name: 'llms-merchant-drift',
    what: 'the agent facts file names a different merchant of record',
    file: 'store/llms.txt',
    replace: ['Merchant of record:** Paddle', 'Merchant of record:** Stripe'],
    expect: /llms\.txt names Stripe but #pay-config says Paddle/,
  },
  {
    name: 'llms-contact-drift',
    what: 'the agent facts file gives a different contact address from the storefront',
    file: 'store/llms.txt',
    replace: ['hello@itikia.co.ke', 'samora@itikia.co.ke'],
    expect: /llms\.txt says samora@itikia\.co\.ke/,
  },
  {
    name: 'llms-drops-a-promised-fact',
    what: 'the agent facts file stops stating what the licence covers',
    file: 'store/llms.txt',
    replace: ['one team, one time, and ', ''],
    expect: /omits what the licence covers/,
  },
  {
    name: 'licence-url-broken',
    what: 'the Product links a licence page the site does not publish',
    file: 'store/pricing.html',
    replace: ['"license": "https://store.itikia.co.ke/terms"', '"license": "https://store.itikia.co.ke/warranty"'],
    expect: /store\/warranty\.html does not exist/,
  },
  {
    name: 'legal-name-drift',
    what: 'the seller legal name in the structured data stops matching the policy pages',
    file: 'store/index.html',
    replace: ['"legalName": "Itikia Digital Solutions"', '"legalName": "Itikia Ltd"'],
    expect: /must name the seller Itikia Ltd/,
  },
  {
    name: 'undeclared-store-file',
    what: 'a new file appears in the publish directory and nobody decides whether it ships',
    create: { file: 'store/mystery-page.html', body: '<!doctype html><title>mystery</title>\n' },
    expect: /neither published nor declared non-public/,
  },
]

function list() {
  console.log(`${MUTATIONS.length} mutations:\n`)
  for (const mutation of MUTATIONS) {
    const target = mutation.file ?? mutation.create.file
    console.log(`  ${mutation.name.padEnd(24)} ${target}`)
    console.log(`    ${mutation.what}`)
    console.log(`    must fail with: ${mutation.expect}\n`)
  }
  return 0
}

/**
 * A throwaway copy of everything the suite reads.
 *
 * NOT a copy of the repository: this tree holds `replication/` (548 MB) and `models/` (605 MB) of unrelated
 * material, so `rsync -a` of the whole thing is 1.9 GB per mutation — the first version of this probe copied that
 * twelve times and had to be killed at ten minutes having produced no output at all. The tracked set plus the
 * working files under the directories the tests read is 225 files and 11 MB, which copies in under a second.
 */
let fileList = null
function copySet() {
  if (fileList) return fileList
  const listed = spawnSync('git', ['-C', REPO, 'ls-files'], { encoding: 'utf8' })
  if (listed.status !== 0) throw new Error('git ls-files failed — this probe needs a git work tree')
  const extra = spawnSync('find', ['tests', 'scripts', 'store', 'tools', 'fixtures', '-type', 'f'],
    { cwd: REPO, encoding: 'utf8' })
  // Untracked working files under those paths matter: the newest guards are not committed yet when this first runs.
  const files = new Set([...listed.stdout.split('\n'), ...(extra.stdout ?? '').split('\n')].filter(Boolean))
  fileList = `${tmpdir()}/mutation-probe-files.txt`
  spawnSync('tee', [fileList], { input: [...files].sort().join('\n') + '\n', encoding: 'utf8' })
  return fileList
}

async function freshCopy() {
  const dir = await mkdtemp(join(tmpdir(), 'mutation-probe-'))
  const result = spawnSync('rsync', ['-a', `--files-from=${copySet()}`, `${REPO}/`, `${dir}/`], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`rsync failed: ${result.stderr?.trim() ?? result.status}`)
  return dir
}

function suite(dir, full) {
  // The Worker tests are included in the fast subset: they execute the real handler, so they are where the
  // money arithmetic is guarded, and a mutation to the amount must be able to fail something.
  const globs = full ? ['tests/*.test.mjs'] : ['tests/storefront-*.test.mjs', 'tests/worker-*.test.mjs']
  const result = spawnSync('node', ['--test', ...globs], { cwd: dir, encoding: 'utf8' })
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

async function apply(mutation, dir) {
  if (mutation.create) {
    const target = join(dir, mutation.create.file)
    await writeFile(target, mutation.create.body)
    return
  }
  const target = join(dir, mutation.file)
  if (!existsSync(target)) throw new Error(`mutation target missing from the copy: ${mutation.file}`)
  const original = await readFile(target, 'utf8')
  const [find, replacement] = mutation.replace
  // A `[null, text]` entry means append, for mutations that corrupt a file without editing its text.
  const mutated = find === null ? original + replacement : original.split(find).join(replacement)
  if (mutated === original) {
    throw new Error(`mutation "${mutation.name}" changed nothing — the anchor no longer matches ${mutation.file}`)
  }
  await writeFile(target, mutated)
}

async function main() {
  if (has('--list')) return list()

  const only = valueOf('--only')
  const selected = only ? MUTATIONS.filter((m) => m.name.includes(only)) : MUTATIONS
  if (selected.length === 0) {
    console.error(`no mutation matches "${only}"`)
    return 1
  }

  // Baseline first: if the copy is not green before any mutation, every verdict below is noise.
  const baselineDir = await freshCopy()
  const baseline = suite(baselineDir, has('--full'))
  await rm(baselineDir, { recursive: true, force: true })
  if (baseline.status !== 0) {
    console.error('REFUSING: the unmutated copy is not green, so a failure below could not be attributed.')
    console.error(baseline.output.split('\n').filter((line) => /^not ok|✖|ℹ (tests|pass|fail)/.test(line)).slice(0, 12).join('\n'))
    return 1
  }
  console.log(`baseline: the unmutated copy passes ${has('--full') ? 'the full suite' : 'the storefront guards'}\n`)

  const rows = []
  for (const mutation of selected) {
    const dir = await freshCopy()
    let row
    try {
      await apply(mutation, dir)
      const run = suite(dir, has('--full'))
      const named = mutation.expect.test(run.output)
      if (run.status === 0) {
        row = { mutation, verdict: 'SURVIVED', detail: 'the suite stayed green — this guard does not bite' }
      } else if (!named) {
        const first = run.output.split('\n').find((line) => /AssertionError|✖/.test(line)) ?? '(no assertion line)'
        row = {
          mutation,
          verdict: 'WRONG REASON',
          detail: `failed, but not with ${mutation.expect} — first line: ${first.trim().slice(0, 160)}`,
        }
      } else {
        const line = run.output.split('\n').find((l) => mutation.expect.test(l)) ?? ''
        row = { mutation, verdict: 'CAUGHT', detail: line.trim().slice(0, 160) }
      }
    } catch (error) {
      row = { mutation, verdict: 'PROBE ERROR', detail: error.message }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
    rows.push(row)
    const mark = row.verdict === 'CAUGHT' ? 'CAUGHT      ' : row.verdict.padEnd(12)
    console.log(`  ${mark} ${row.mutation.name}`)
    if (row.verdict !== 'CAUGHT') console.log(`               ${row.detail}`)
  }

  const bad = rows.filter((row) => row.verdict !== 'CAUGHT')
  console.log('')
  console.log(`${rows.length - bad.length}/${rows.length} mutations caught by a guard that named the defect`)
  if (bad.length > 0) {
    console.log(`\nNOT ALL GUARDS BITE — ${bad.length} mutation(s) were not caught for the stated reason:`)
    for (const row of bad) console.log(`  - ${row.mutation.name}: ${row.verdict} — ${row.detail}`)
    return 1
  }
  return 0
}

process.exitCode = (await main().catch((error) => {
  console.error(`probe error: ${error.message ?? error}`)
  return 1
})) ?? 0
