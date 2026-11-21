/**
 * The licence URL must answer HEAD, not just GET.
 *
 * FOUND 2026-11-21, after a licence issued against invoice 55704-10003 downloaded perfectly while
 * `curl -I` on the same URL returned **404**. The router matched only `request.method === 'GET'`, so
 * every HEAD fell through to the not-found branch. Anything that probes before it fetches — link
 * previewers, download managers, uptime monitors, `curl -I`, some mail clients — therefore reported a
 * working, paid-for licence as missing.
 *
 * The rule: a resource served on GET must answer HEAD with the same status and headers, differing only
 * in having no body.
 *
 * These are source assertions because the Worker module is not executed by the suite; they are written
 * from the DEFECT (a HEAD reaching the 404 branch), not from the shape of the fix.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const repo = new URL('..', import.meta.url)

async function workerCode() {
  const raw = await readFile(new URL('worker/licence/src/index.js', repo), 'utf8')
  // Strip comments first: a commented-out route is not a route, and this project has twice shipped a
  // guard that stayed green on commented-out code (census: assert on executable text, not on source).
  return raw
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|\*|\/\*)/u.test(line))
    .join('\n')
}

test('the licence route is reachable by HEAD as well as GET', async () => {
  const code = await workerCode()

  assert.match(
    code,
    /request\.method === 'GET' \|\| request\.method === 'HEAD'/u,
    'the router must treat HEAD as a read, or every prober sees a 404 for a licence that downloads fine',
  )
  assert.match(
    code,
    /serveLicence\(url, env, request\.method\)/u,
    'the request method must reach serveLicence, so it can omit the body for HEAD',
  )
})

test('a HEAD response carries the same status and headers, and no body', async () => {
  const code = await workerCode()

  assert.match(
    code,
    /new Response\(method === 'HEAD' \? null : record\.doc/u,
    'the licence document must not be written into a HEAD response body',
  )
  assert.match(
    code,
    /new Response\(method === 'HEAD' \? null : JSON\.stringify\(payload\)/u,
    'the JSON helper must drop its body for HEAD too, including the health route',
  )
})
