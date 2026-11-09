/**
 * The storefront names one artifact — its version and its sha256 — in static
 * HTML, which cannot derive either. This is the same stale-hash defect that bit
 * this build once already (a hardcoded sha256 in a page that no longer matched
 * the file), so the page is graded against `dist/` on every test run.
 *
 * It is also the page a buyer compares their download against: if it is wrong,
 * a correct download fails verification.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const repo = new URL('..', import.meta.url)

async function context() {
  const pkg = JSON.parse(await readFile(new URL('package.json', repo), 'utf8'))
  const page = await readFile(new URL('store/index.html', repo), 'utf8')
  return { pkg, page }
}

test('the storefront names the artifact that is actually in dist/, by version and hash', async () => {
  const { pkg, page } = await context()
  const artifact = await readFile(new URL(`dist/${pkg.name}-${pkg.version}.tar.gz`, repo))
  const sha256 = createHash('sha256').update(artifact).digest('hex')

  const declared = /var HASH = '([0-9a-f]{64})'/u.exec(page)
  assert.ok(declared !== null, 'store/index.html must declare the artifact hash')
  assert.equal(declared[1], sha256, 'the storefront hash must be the sha256 of the artifact in dist/')

  const version = /var V = '([^']+)'/u.exec(page)
  assert.ok(version !== null, 'store/index.html must declare the artifact name')
  assert.equal(version[1], `${pkg.name}-${pkg.version}`, 'the storefront must name package.json\'s version')

  // The buyer is told how to verify the download; that command must name the files they get.
  assert.match(page, new RegExp(`sha256sum -c ${pkg.name}-${pkg.version}\\.tar\\.gz\\.sha256`, 'u'))
})

test('the shipped artifact carries the release it claims', async () => {
  const { pkg } = await context()
  const tarball = await readFile(new URL(`dist/${pkg.name}-${pkg.version}.tar.gz`, repo))
  const digest = createHash('sha256').update(tarball).digest('hex')
  // The sidecar the buyer checks against must describe this exact file.
  const sidecar = await readFile(new URL(`dist/${pkg.name}-${pkg.version}.tar.gz.sha256`, repo), 'utf8')
  assert.equal(sidecar.trim().split(/\s+/u)[0], digest)
})

test('the storefront claims the test count the suite actually has', async () => {
  // The page said "97/97 unit tests" for two releases after the suite had grown: a marketing number
  // nobody re-derives is a claim the code does not keep. The count is derivable, so it is asserted:
  // one `test(` declaration per test, which is exactly what the runner reports (106 = 106).
  const { readdir } = await import('node:fs/promises')
  const page = await readFile(new URL('store/index.html', repo), 'utf8')
  const files = (await readdir(new URL('tests/', repo))).filter((name) => name.endsWith('.test.mjs'))
  let declared = 0
  for (const name of files) {
    const source = await readFile(new URL(`tests/${name}`, repo), 'utf8')
    declared += source.split('\n').filter((line) => line.startsWith('test(')).length
  }
  // Strip tags first: both places that state this count wrap the number in <b>/<span>, so matching raw
  // HTML missed the proof-list copy entirely. The page shipped saying 113/113 in one place and 114/114
  // in another while this guard stayed green. Rendered text is what a buyer reads — grade that.
  const pageText = page.replace(/<[^>]+>/gu, ' ').replace(/\s+/gu, ' ')
  const claimed = [...pageText.matchAll(/(\d+)\/(\d+) unit tests/gu)]
  assert.ok(claimed.length > 0, 'the storefront must state the unit-test count')
  for (const [, passing, total] of claimed) {
    assert.equal(passing, total, 'a "N/N unit tests" claim must not describe a partial pass')
    assert.equal(
      Number(total),
      declared,
      `the storefront claims ${total} unit tests but tests/ declares ${declared}`
    )
  }
})
