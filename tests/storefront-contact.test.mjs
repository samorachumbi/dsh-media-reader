/**
 * The contact form as a visitor meets it — and the privacy policy that has to tell the truth about it.
 *
 * Three failure modes, all of them seen in the wild and all of them silent:
 *   1. a form that posts nowhere, or to an endpoint the Worker does not serve (the button "works" and the
 *      message is lost);
 *   2. a honeypot that is visible, focusable or announced — which makes it a field real people fill in, and
 *      their message then disappears without a word;
 *   3. a privacy policy that still says "we only hold what you email us" while a form is collecting names,
 *      addresses and free text through a third party.
 *
 * The page is also the only place the visitor is told what happens to what they type, so the wording is
 * checked for the promises the implementation actually keeps.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const repo = new URL('..', import.meta.url)
const read = (path) => readFile(new URL(path, repo), 'utf8')

const page = await read('store/index.html')
const privacy = await read('store/privacy.html')
const worker = await read('worker/licence/src/index.js')

const section = (() => {
  const match = /<section id="contact"[\s\S]*?<\/section>/u.exec(page)
  assert.ok(match !== null, 'the storefront must carry a #contact section — GitHub and the footer both point at it')
  return match[0]
})()
const form = (() => {
  const match = /<form[^>]*id="contact-form"[\s\S]*?<\/form>/u.exec(section)
  assert.ok(match !== null, 'the #contact section must carry the contact form')
  return match[0]
})()

test('the form posts to the endpoint the Worker actually serves', () => {
  const action = /action="([^"]+)"/u.exec(form)
  assert.ok(action !== null, 'the form needs an action, so a no-JS submit still goes somewhere sensible')
  const endpoint = /https:\/\/dsh-licence\.itikia\.workers\.dev\/contact/u.exec(page)
  assert.ok(endpoint !== null, 'the page must name the contact endpoint')
  assert.match(worker, /url\.pathname === '\/contact'/u, 'the Worker must serve the path the page posts to')
  assert.match(worker, /request\.method === 'OPTIONS' && url\.pathname === '\/contact'/u,
    'without the preflight the browser cannot call it at all')
  assert.match(action[1], /^mailto:/u,
    'with JavaScript off, a mail client is the honest fallback — a JSON endpoint would answer a form post with an error')
})

test('the honeypot is hidden from sight, from the tab order AND from assistive technology', () => {
  const honeypot = /<div class="contact-hp"[^>]*>([\s\S]*?)<\/div>/u.exec(form)
  assert.ok(honeypot !== null, 'the honeypot wrapper must exist')
  assert.match(honeypot[0], /aria-hidden="true"/u, 'a screen reader must not announce a field nobody should fill')
  assert.match(honeypot[1], /tabindex="-1"/u, 'and it must not be reachable by keyboard')
  assert.match(honeypot[1], /name="website"/u, 'the field name the Worker checks must match this input')
  assert.match(honeypot[1], /autocomplete="off"/u, 'browsers must not autofill it either')
  assert.match(worker, /payload\?\.website/u, 'the Worker must actually test the field the page ships')
})

test('every field the Worker requires is on the page and labelled', () => {
  for (const field of ['name', 'email', 'message']) {
    assert.match(form, new RegExp(`name="${field}"`, 'u'), `the page must send ${field}`)
    const id = new RegExp(`id="cf-${field}"`, 'u').exec(form)
    assert.ok(id !== null, `${field} needs an id so its label can point at it`)
    assert.match(form, new RegExp(`<label for="cf-${field}"`, 'u'), `${field} needs a real label, not a placeholder`)
  }
  assert.match(form, /maxlength="4000"/u, 'the message cap the Worker enforces must be the one the page states')
})

test('the visitor is told where the message goes, and that nothing is stored here', () => {
  assert.match(section, /samora@itikia\.co\.ke/u, 'the section must name the human who reads it')
  assert.match(section, /nothing is stored on this site/iu, 'the form must state what it does not do')
  assert.match(form, /role="status"/u) && assert.match(form, /aria-live="polite"/u)
  assert.match(form, /<noscript>/u, 'a visitor without JavaScript must be told how to reach the same person')
  assert.match(section, /one business day/iu, 'the reply promise must be the one the SUPPORT.md makes')
})

test('a failed send never claims success, and a lost message always leaves an email route', () => {
  // Find the block by its own marker: the first "contact-form" in the file is the markup, and a lazy match
  // from there lands on whichever <script> happens to close first — which is a different feature entirely.
  const at = page.indexOf("getElementById('contact-form')")
  assert.ok(at > -1, 'the contact script must exist')
  const script = page.slice(page.lastIndexOf('<script>', at), page.indexOf('</script>', at))
  assert.match(script, /button\.disabled = true/u, 'the button must not stay live while the request is in flight')
  assert.match(script, /Nothing was sent/iu, 'an error must say plainly that nothing was sent')
  assert.match(script, /mailto:samora@itikia\.co\.ke/u, 'and must still give a route that works')
  assert.match(script, /result\.status === 429/u, 'the rate limit has its own honest message')
  assert.match(script, /headers: \{ 'content-type': 'application\/json' \}/u,
    'the POST must be JSON, so the browser preflights it and the Worker can refuse a plain form post')
})

test('the privacy policy describes the form it now carries', () => {
  const text = privacy.replace(/<[^>]+>/gu, ' ').replace(/\s+/gu, ' ')
  assert.match(text, /contact form/iu, 'the policy must mention the form — it collects personal data the old text denied')
  assert.match(text, /name/iu)
  assert.match(text, /email address/iu)
  assert.match(text, /rate limit|rate-limit/iu, 'the policy must disclose that the caller address is used to rate-limit')
  assert.match(text, /hash/iu, 'the policy must state that only a hash of the caller address is kept')
  // A disclosure a reader cannot find is not a disclosure: it needs its own numbered section, the way every
  // other category on this page is presented. A sentence buried in another section is how a policy ends up
  // technically true and practically hidden.
  assert.match(privacy, /<h2>[0-9]+\. What the contact form sends<\/h2>/u,
    'the form disclosure must be its own numbered section')
  assert.match(text, /no analytics/iu, 'the existing no-analytics claim must survive')
  assert.match(text, /no trackers/iu, 'the existing no-trackers claim must survive')
  assert.doesNotMatch(text, /We only hold what you email us/iu,
    'the old sentence is now false: a form also collects what you type')
})
