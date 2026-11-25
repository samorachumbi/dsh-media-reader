/**
 * Discovery surfaces — README, package metadata and llms.txt.
 *
 * The failure these prevent was measured on 2026-11-19: GitHub, dshfind, dsh-plugin.org and
 * dshplugin.online all exposed the plugin, but a reader had to reach the very bottom of the README
 * before finding the commercial route, and the public `llms.txt` had no store link at all. It also
 * claimed a defect that 0.1.1 had already fixed.
 *
 * These are text claims with machine-readable counterparts. Grade the rendered/static text against
 * the same #pay-config the page actually charges from, and against the artifact that actually ships.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const repo = new URL('..', import.meta.url)
const read = (path) => readFile(new URL(path, repo), 'utf8')

function payConfig(html) {
  const match = /<script type="application\/json" id="pay-config">([\s\S]*?)<\/script>/u.exec(html)
  assert.ok(match !== null, 'index.html must carry a #pay-config JSON block')
  return JSON.parse(match[1])
}

const NUMBER_WORD = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight']

test('README routes to the commercial licence before the technical material and counts its tools truthfully', async () => {
  const readme = await read('README.md')
  const cfg = payConfig(await read('store/index.html'))

  const ctaAt = readme.indexOf('**Commercial licence:**')
  const installAt = readme.indexOf('## Install (this machine)')
  assert.ok(ctaAt > -1, 'README must carry a Commercial licence callout')
  assert.ok(installAt > -1, 'README must still have an Install section')
  assert.ok(ctaAt < installAt,
    'the commercial callout must appear BEFORE the installation instructions, or discovery ends at the bottom of the page')

  const commercialUrl = 'https://store.itikia.co.ke/?utm_source=github&utm_medium=repo&utm_campaign=discovery_repair'
  assert.ok(readme.includes(commercialUrl),
    `the top callout must link through the tagged repository route: ${commercialUrl}`)

  assert.ok(readme.includes(`$${cfg.price.usd} / KSh 10,000`),
    'the README price must match #pay-config (USD and KSh)')

  // The table is the machine-readable count; a stale word in the prose is a public false claim.
  const tools = [...readme.matchAll(/^\| `(media_[a-z]+)` \|/gmu)].map((match) => match[1])
  assert.equal(tools.length, 5, `the README tool table must have five rows, found: ${tools.join(', ')}`)
  assert.ok(readme.includes(`${NUMBER_WORD[tools.length]} tools, one redirect`),
    `the README must say "${NUMBER_WORD[tools.length]} tools", matching its own table`)
  assert.doesNotMatch(readme, /\bFour tools, one redirect/u, 'the old four-tool claim must not return')
})

test('llms.txt routes agents through the live commercial pages and carries no fixed-defect claim', async () => {
  const llms = await read('store/llms.txt')
  const pkg = JSON.parse(await read('package.json'))

  assert.match(llms, /^Last updated: \d{4}-\d{2}-\d{2}$/mu, 'llms.txt must state when it was last checked')
  assert.ok(llms.includes('https://store.itikia.co.ke/?utm_source=llms&utm_medium=agent&utm_campaign=discovery_repair'),
    'llms.txt must route an agent to the storefront with its own acquisition source')
  for (const url of [
    'https://store.itikia.co.ke/pricing',
    'https://store.itikia.co.ke/refund',
    'https://store.itikia.co.ke/terms',
    'https://github.com/samorachumbi/dsh-media-reader/blob/main/LICENSE',
  ]) {
    assert.ok(llms.includes(url), `llms.txt must link ${url}`)
  }

  assert.doesNotMatch(llms, /Known defect:/iu, 'the fixed draft-path defect must not be advertised as current')
  assert.doesNotMatch(llms, /absolute artifact paths/iu, 'the removed defect wording must not return')

  // Derive the shipped skill count from the artifact, not a word someone can forget to edit.
  const artifact = fileURLToPath(new URL(`dist/${pkg.name}-${pkg.version}.tar.gz`, repo))
  const listing = execFileSync('tar', ['tzf', artifact], { encoding: 'utf8' })
  const skills = [...new Set([...listing.matchAll(/\/([^/]+)\/SKILL\.md/gu)].map((match) => match[1]))]
  // Derive the expectation from the build script too: a literal here is the same defect this guard exists to
  // catch — a number someone forgets to edit when a skill is added (it read 5 while the artifact shipped 6).
  const build = await read('dist-tools/build-bundle.sh')
  const declared = [...build.matchAll(/^copy_skill\s+(\S+)\s+(\S+)$/gmu)].map((match) => match[1])
  assert.ok(declared.length > 0, 'build-bundle.sh must declare the skills it ships')
  assert.equal(skills.length, declared.length,
    `artifact must ship the ${declared.length} skills build-bundle.sh declares, found ${skills.length}`)
  for (const name of declared) {
    assert.ok(skills.includes(name), `the artifact must ship the declared skill "${name}"`)
  }
  // The wording carries the number too, so it is derived as well rather than pinned to "five".
  const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']
  assert.match(llms, new RegExp(`ships ${words[skills.length]} skills`, 'u'),
    `llms.txt must state "ships ${words[skills.length]} skills" to match the ${skills.length} in the artifact`)
  for (const skill of skills) {
    assert.ok(llms.includes(skill), `llms.txt must name the shipped skill ${skill}`)
  }
})

test('README and llms.txt agree with the storefront price and keep the canonical package homepage clean', async () => {
  const [readme, llms, pkgText, html] = await Promise.all([
    read('README.md'), read('store/llms.txt'), read('package.json'), read('store/index.html'),
  ])
  const cfg = payConfig(html)
  const pkg = JSON.parse(pkgText)

  const prices = [...`${readme}\n${llms}`.matchAll(/\$(\d+) \/ KSh ([\d,]+)/gu)]
  assert.ok(prices.length >= 3, 'commercial price must appear in the README top, README licence section and llms.txt')
  for (const [, usd, kes] of prices) {
    assert.equal(Number(usd), cfg.price.usd, `README/llms USD price ${usd} disagrees with #pay-config ${cfg.price.usd}`)
    assert.equal(Number(kes.replaceAll(',', '')), cfg.price.kes,
      `README/llms KSh price ${kes} disagrees with #pay-config ${cfg.price.kes}`)
  }

  assert.equal(pkg.homepage, 'https://store.itikia.co.ke',
    'package homepage must stay the clean canonical URL; campaign tags belong on placement links')
  assert.equal(pkg.license, 'UNLICENSED', 'the package must remain proprietary')
})
