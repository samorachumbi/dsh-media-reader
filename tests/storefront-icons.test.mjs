/**
 * Storefront icons — the favicon contract.
 *
 * Why this file exists: on 2026-11-16 the previous favicon (borrowed from the Digital Front Desk
 * site) turned out to fill its robot body with `url(#brand-glass-pearl)` and `url(#brand-rim)` while
 * defining NEITHER gradient. In the page it looked fine, because the gradients were defined inline
 * beside it; fetched on its own as `/favicon.svg` the body rendered as nothing, and it shipped as
 * floating ears, eyes and a tail. Nothing failed. A favicon is the one asset nobody looks at closely
 * and every browser fetches alone, so it is checked mechanically here.
 *
 *   - an unresolved paint reference is a hard failure, not a warning;
 *   - a favicon may not use a gradient at all (at 16 px it is mud, see the mascot learning);
 *   - every declared icon must exist, be the size it claims, and be declared on EVERY page.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, stat, readdir } from 'node:fs/promises'

const repo = new URL('..', import.meta.url)
const storeFile = (name) => readFile(new URL(`store/${name}`, repo), 'utf8')
const PAGES = ['index.html', 'pricing.html', 'terms.html', 'privacy.html', 'refund.html', '404.html']

async function pngHeader(path) {
  const bytes = await readFile(new URL(path, repo))
  assert.equal(bytes.subarray(1, 4).toString('latin1'), 'PNG', `${path} is not a PNG`)
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    bitDepth: bytes[24],
    colorType: bytes[25], // 6 = RGBA, 2 = RGB
  }
}

test('the favicon declares no paint it does not define, and is flat', async () => {
  const svg = await storeFile('assets/favicon.svg')

  // 1. every url(#id) must resolve to an element carrying that id in THIS file
  const referenced = [...svg.matchAll(/url\(#([A-Za-z0-9_-]+)\)/gu)].map((m) => m[1])
  for (const id of referenced) {
    const defined = new RegExp(`id="${id}"`, 'u').test(svg)
    assert.ok(
      defined,
      `favicon.svg references paint url(#${id}) but defines no element with that id — it will render ` +
      'as nothing, silently, because a favicon is fetched on its own',
    )
  }

  // 2. a gradient at 16 px is mud: the mark must be a literal colour
  assert.doesNotMatch(svg, /<(linear|radial)Gradient/iu, 'the favicon must not use a gradient')

  // 3. it must actually be a square canvas, or browsers scale it unpredictably
  const viewBox = /viewBox="([^"]+)"/u.exec(svg)
  assert.ok(viewBox, 'favicon.svg needs a viewBox')
  const [, , w, h] = viewBox[1].trim().split(/[\s,]+/u).map(Number)
  assert.equal(w, h, `the favicon viewBox must be square, got ${w}x${h}`)
})

test('every page declares the icons, and every declared file exists at the size it claims', async () => {
  for (const page of PAGES) {
    const html = await storeFile(page)
    assert.match(html, /rel="icon"[^>]+href="assets\/favicon\.svg"[^>]+type="image\/svg\+xml"/u,
      `${page} must declare the SVG favicon`)
    assert.match(html, /rel="icon"[^>]+href="assets\/favicon-32\.png"[^>]+sizes="32x32"/u,
      `${page} must declare the 32px PNG fallback`)
    assert.match(html, /rel="apple-touch-icon"[^>]+href="assets\/apple-touch-icon\.png"/u,
      `${page} must declare an apple-touch-icon`)
    assert.match(html, /name="theme-color"/u, `${page} must declare a theme-color`)
  }

  // The PNGs are real files at the sizes THEIR OWN markup claims. Read each <link> tag on its own:
  // matching sizes="…" across the whole page picks up whichever attribute appears first and grades
  // every icon against it — which is exactly how this assertion first failed on a correct asset.
  for (const page of PAGES) {
    const html = await storeFile(page)
    const tags = [...html.matchAll(/<link[^>]*\brel="(?:icon|apple-touch-icon)"[^>]*>/gu)].map((m) => m[0])
    assert.ok(tags.length >= 3, `${page} should declare three icon links`)

    for (const tag of tags) {
      const href = /href="([^"]+\.png)"/u.exec(tag)
      if (!href) continue
      const info = await pngHeader(`store/${href[1]}`)
      const sizes = /sizes="(\d+)x(\d+)"/u.exec(tag)
      if (sizes) {
        assert.equal(info.width, Number(sizes[1]), `${href[1]} claims ${sizes[1]}px wide but is ${info.width}`)
        assert.equal(info.height, Number(sizes[2]), `${href[1]} claims ${sizes[2]}px tall but is ${info.height}`)
      }
    }
  }

  // the touch icon is what iOS masks, so it must be 180x180 and OPAQUE (no alpha corners)
  const touch = await pngHeader('store/assets/apple-touch-icon.png')
  assert.equal(touch.width, 180, 'apple-touch-icon.png must be 180px wide')
  assert.equal(touch.height, 180, 'apple-touch-icon.png must be 180px tall')
  assert.equal(touch.colorType, 2, 'apple-touch-icon.png must be opaque RGB — iOS shows alpha corners as black')

  // the 32px fallback keeps its transparency so it sits on any tab colour
  const small = await pngHeader('store/assets/favicon-32.png')
  assert.equal(small.width, 32, 'favicon-32.png must be 32px wide')
  assert.equal(small.colorType, 6, 'favicon-32.png should carry an alpha channel')

  // and the icons must actually be published, not just present
  const deploy = await readFile(new URL('tools/deploy-store.sh', repo), 'utf8')
  assert.match(deploy, /WHITELIST=\([^)]*assets/u, 'assets/ must be in the deploy whitelist')
})

test('no icon file in the store refers to a paint defined in another file', async () => {
  // guards the class, not just the instance: any SVG that ships from store/assets is fetched
  // standalone, so every one of them has to be self-contained.
  const dir = new URL('store/assets/', repo)
  const svgs = (await readdir(dir)).filter((n) => n.endsWith('.svg'))
  assert.ok(svgs.length > 0, 'expected at least one SVG in store/assets')

  for (const name of svgs) {
    const svg = await readFile(new URL(name, dir), 'utf8')
    for (const [, id] of svg.matchAll(/url\(#([A-Za-z0-9_-]+)\)/gu)) {
      assert.ok(new RegExp(`id="${id}"`, 'u').test(svg),
        `store/assets/${name} references url(#${id}) with no matching id in the same file`)
    }
    await stat(new URL(name, dir)) // must exist and be readable
  }
})
