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
