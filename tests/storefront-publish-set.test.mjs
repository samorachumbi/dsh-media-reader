/**
 * The publish set — L3 of the LLM-readability plan.
 *
 * `tools/deploy-store.sh` publishes a WHITELIST, not the whole directory, so a file can exist in git, pass every
 * test, and never reach production. That is exactly what happened to `store/robots.txt`: written in L2, guarded by
 * its own tests, and absent from the deploy list — so the live robots.txt would still have been Cloudflare's edge
 * file, and L4 would have recorded the edge as the reason.
 *
 * These checks make the publish set two-sided:
 *   - anything that must be public is on the list (or it silently does not ship);
 *   - anything not on the list is declared non-public with a reason (or a new public file ships by accident, or a
 *     secret gets staged because nobody looked).
 *
 * The list is parsed out of the deploy script rather than copied here, because a copy would drift silently and a
 * guard on a copy guards nothing.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir, stat } from 'node:fs/promises'
import { relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = new URL('..', import.meta.url)
const read = (path) => readFile(new URL(path, repo), 'utf8')

/** Files that MUST be published. Derived from the surfaces the other guards test, not from the whitelist. */
const MUST_PUBLISH = [
  'index.html',
  'pricing.html',
  'privacy.html',
  'terms.html',
  'refund.html',
  '404.html',
  'llms.txt',
  'robots.txt',
  'assets/policies.css',
]

/**
 * Deliberately NOT published, each with the reason it must stay off the public site. A file that is neither
 * published nor listed here fails the last test, so adding one is a decision rather than an omission.
 */
const NOT_PUBLISHED = {
  'README.md': 'the operator runbook — internal instructions, not a public page',
  'DEPLOYED-URL': 'local metadata naming where the site lives',
  'evidence/': 'multi-megabyte test screenshots; the plan keeps them out of the published site',
}

const deployScript = await read('tools/deploy-store.sh')

/** The WHITELIST array as written in the deploy script. */
function whitelist() {
  const match = /^WHITELIST=\(([^)]*)\)/mu.exec(deployScript)
  assert.ok(match, 'tools/deploy-store.sh must declare WHITELIST=(...) — without it this guard checks nothing')
  const items = match[1].trim().split(/\s+/u).filter(Boolean)
  assert.ok(items.length > 0, 'the deploy whitelist must not be empty')
  return items
}

const published = (relPath, list) =>
  list.includes(relPath) || list.some((item) => relPath.startsWith(`${item}/`))

test('every file the site must serve is on the deploy whitelist', async () => {
  const list = whitelist()
  const missing = MUST_PUBLISH.filter((file) => !published(file, list))
  assert.deepEqual(missing, [],
    `these files exist on disk but would never ship: ${missing.join(', ')} — add them to WHITELIST in tools/deploy-store.sh`)
})

test('robots.txt specifically is published, and the deploy stages it', async () => {
  // Named separately from the loop above because the failure this guard exists for is this exact file.
  assert.ok(whitelist().includes('robots.txt'),
    'store/robots.txt must be in the deploy whitelist: Cloudflare serves its own edge file, so publishing ours is ' +
    'the only way to find out whether it is overridden — and nothing ships if it is not listed')
  const entry = await stat(new URL('store/robots.txt', repo))
  assert.ok(entry.size > 0, 'store/robots.txt must not be empty')
})

test('every whitelisted entry exists, so a deploy cannot ship a half-missing site', async () => {
  const list = whitelist()
  const absent = []
  for (const item of list) {
    const exists = await stat(new URL(`store/${item}`, repo)).then(() => true, () => false)
    if (!exists) absent.push(item)
  }
  assert.deepEqual(absent, [], `the deploy whitelist names files that do not exist: ${absent.join(', ')}`)
})

test('a file in store/ that ships is on the whitelist, and one that does not is declared', async () => {
  const list = whitelist()
  const storeRoot = fileURLToPath(new URL('store/', repo))
  const all = await readdir(storeRoot, { recursive: true, withFileTypes: true })
  const files = all
    .filter((d) => d.isFile())
    .map((d) => relative(storeRoot, `${d.parentPath}/${d.name}`))

  const undeclared = files.filter((file) => {
    if (published(file, list)) return false
    if (NOT_PUBLISHED[file]) return false
    return !Object.keys(NOT_PUBLISHED).some((prefix) => prefix.endsWith('/') && file.startsWith(prefix))
  })

  assert.deepEqual(undeclared, [],
    `these files are neither published nor declared non-public: ${undeclared.join(', ')} — add each to WHITELIST ` +
    'or to NOT_PUBLISHED in this test with the reason it stays internal')
})

test('the pre-flight before a publish runs every storefront guard, not a single file', async () => {
  // A publish that only runs the rails guard can ship a page whose JSON-LD contradicts #pay-config, because those
  // guards live in other files. Whatever the pre-flight glob is, it must cover all of them.
  const globs = [...deployScript.matchAll(/node --test (tests\/storefront[^\s)]*)/gu)].map((m) => m[1])
  assert.ok(globs.length > 0, 'the deploy script must run storefront guards before publishing')
  for (const glob of globs) {
    assert.match(glob, /storefront-\*\.test\.mjs$/u,
      `the pre-flight runs "${glob}" — a single guard file is not the storefront guard set; use tests/storefront-*.test.mjs`)
  }
  const onDisk = (await readdir(new URL('tests/', repo))).filter((f) => /^storefront-.*\.test\.mjs$/u.test(f))
  assert.ok(onDisk.length >= 7, `expected the storefront guard suite on disk, found ${onDisk.length} files`)
})
