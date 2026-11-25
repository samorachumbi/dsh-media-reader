#!/usr/bin/env node
/**
 * capture.mjs — screenshot a page through the Chrome DevTools Protocol, with no dependencies.
 *
 * Why this exists: visual claims on this machine kept being made without a render. The census records the cost —
 * eleven checks that only ever exercised ONE theme (D11), a capture too short that reported a feature as missing
 * (D5/D9, four times), a `--virtual-time-budget` that hung on a page holding a connection (D16), and five landings
 * of the `pkill -f` family. So:
 *
 *   - the child Chrome is OURS: its pid is recorded at spawn and killed in `process.on('exit')`. Nothing is ever
 *     found by pattern, so this cannot kill the shell that started it.
 *   - no `--virtual-time-budget`: readiness is polled (readyState complete + a real element present), under a hard
 *     timeout, because a page that holds a connection open never goes idle.
 *   - both themes and reduced-motion are emulated explicitly, because "it looks right" is only true of the mode
 *     that was rendered.
 *   - `--full` shoots the whole document height (taller than the page), because a capture that stops at the fold
 *     reports real content as absent.
 *
 *   node scripts/capture.mjs --url <url> --out <dir> [--width 1440] [--height 900]
 *        [--theme light|dark] [--reduced] [--shots 0,1000,2000,4000,8000] [--full] [--scroll 0]
 *        [--selector <css>] [--prefix <name>] [--timeout 30000] [--eval <js>]
 *        [--click '<css>@<ms>']   repeatable; clicks once when the frame clock reaches <ms> (default 0)
 *        [--headful]              a real window instead of --headless=new (positioned off screen)
 *
 * --click exists for the states a still frame cannot otherwise reach: a paused animation, an opened panel, a
 * toggled theme. Without it "the Pause button works" can only ever be a claim about the markup.
 *
 * Writes <out>/<prefix>-<theme>[-reduced]-<shot>.png plus <out>/manifest.json, which states what the frames do and
 * do NOT prove. Exit 0 only when every frame was captured.
 */
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const arg = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? fallback : (argv[i + 1] ?? '')
}
const flag = (name) => argv.includes(`--${name}`)

const URL_ = arg('url')
if (!URL_) {
  console.error('usage: node scripts/capture.mjs --url <url> --out <dir> [--width N] [--height N] [--theme light|dark] [--reduced] [--shots a,b,c] [--full] [--scroll Y] [--selector css] [--prefix name] [--timeout ms]')
  process.exit(2)
}
const OUT = arg('out', '/tmp/capture')
const WIDTH = Number(arg('width', '1440'))
const HEIGHT = Number(arg('height', '900'))
const THEME = arg('theme', 'light')
const REDUCED = flag('reduced')
const FULL = flag('full')
const SCROLL = Number(arg('scroll', '0'))
const SELECTOR = arg('selector', 'body')
const TIMEOUT = Number(arg('timeout', '30000'))
const SHOTS = arg('shots', '0')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s !== '')            // `--shots ""` means no frames, not one frame at 0ms
  .map((s) => Number(s))
  .filter((n) => Number.isFinite(n))
const PREFIX = arg('prefix', 'shot')
// --eval exists because an animation's state is not visible in a PNG: "paused" and "finished" look identical, and
// reading computed style/DOM at a named moment is the only honest evidence for either. Evaluated once per frame,
// after that frame's delay, so the trace lines up with the images.
const EVAL = arg('eval')
// Some third-party pages (payment checkouts) gate headless clients with a bot challenge, so their real content is
// unreachable headless. A window that Chrome really renders passes, and the window is placed off screen so it does
// not appear in front of whoever is using the machine. This is not a bypass: it is the same browser a buyer uses.
const HEADFUL = flag('headful')
// Every --click value, in the order given. Each fires once, at the first frame at or after its millisecond.
const CLICKS = argv.reduce((list, token, index) => {
  if (token !== '--click') return list
  const raw = argv[index + 1] ?? ''
  const cut = raw.lastIndexOf('@')
  const selector = cut === -1 ? raw : raw.slice(0, cut)
  const at = cut === -1 ? 0 : Number(raw.slice(cut + 1))
  if (selector === '' || !Number.isFinite(at)) {
    console.error(`--click needs "<css>@<ms>", got "${raw}"`)
    process.exit(2)
  }
  list.push({ selector, at, done: false })
  return list
}, [])

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ─────────────────────────────────────────────────────────────── chrome, owned not discovered ── */

const userDir = await mkdtemp(join(tmpdir(), 'capture-profile-'))
const chrome = spawn('google-chrome', [
  ...(HEADFUL ? [] : ['--headless=new']),
  '--remote-debugging-port=0',            // let Chrome pick a free port and write it to DevToolsActivePort
  `--user-data-dir=${userDir}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-dev-shm-usage',
  '--hide-scrollbars', '--force-device-scale-factor=1',
  // This machine's desktop is Wayland (GNOME, gdm-password). Without an explicit ozone platform Chrome tries
  // X11, finds no authorised X server, and dies before writing DevToolsActivePort — which reads as "Chrome
  // never started" rather than "Chrome could not reach a display". Headful therefore implies Wayland here.
  ...(HEADFUL ? ['--ozone-platform=wayland', '--window-position=40,40', '--window-size=1280,900'] : []),
  'about:blank',
], {
  stdio: ['ignore', 'ignore', 'pipe'],
  // A headful child needs the live session's bus and compositor, which this shell inherits neither of.
  env: HEADFUL
    ? { ...process.env, WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY ?? 'wayland-0', XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 1000}` }
    : process.env,
})

// The pid is recorded when we spawn it, so cleanup never needs a pattern — the fifth `pkill -f` landing was a
// pattern matching the shell that ran it.
const chromePid = chrome.pid
let chromeGone = false
const killChrome = () => {
  if (chromeGone) return
  chromeGone = true
  try { process.kill(chromePid, 'SIGKILL') } catch { /* already gone */ }
}
process.on('exit', killChrome)
process.on('SIGINT', () => { killChrome(); process.exit(130) })

async function debugPort() {
  const file = join(userDir, 'DevToolsActivePort')
  for (let i = 0; i < 150; i++) {
    try {
      const text = await readFile(file, 'utf8')
      const port = text.split('\n')[0].trim()
      if (port) return Number(port)
    } catch { /* not written yet */ }
    await sleep(100)
  }
  throw new Error('Chrome never wrote DevToolsActivePort — it did not start')
}

/** Minimal CDP client over the global WebSocket (Node 22+). No dependencies, one socket per target. */
function attach(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const pending = new Map()
    const events = []
    let seq = 0
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data)
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id)
        pending.delete(msg.id)
        if (msg.error) rej(new Error(`${msg.error.message} (${msg.error.code})`))
        else res(msg.result)
        return
      }
      events.push(msg)
    })
    ws.addEventListener('open', () => resolve({
      send(method, params = {}, sessionId) {
        const id = ++seq
        return new Promise((res, rej) => {
          pending.set(id, { res, rej })
          ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
        })
      },
      events,
      close: () => ws.close(),
    }))
    ws.addEventListener('error', () => reject(new Error('could not open the CDP websocket')))
  })
}

/** A promise that never outlives the hard timeout — D16 is what happens without one. */
function withTimeout(promise, ms, what) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} exceeded ${ms}ms`)), ms)),
  ])
}

/* ────────────────────────────────────────────────────────────────────────────────── capture ── */

async function main() {
  await mkdir(OUT, { recursive: true })
  const port = await debugPort()
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
  const client = await attach(version.webSocketDebuggerUrl)

  const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true })
  const send = (method, params = {}) => client.send(method, params, sessionId)

  await send('Page.enable')
  await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false,   // mobile:false measures true CSS pixels
  })
  await send('Emulation.setEmulatedMedia', {
    features: [
      { name: 'prefers-color-scheme', value: THEME },
      { name: 'prefers-reduced-motion', value: REDUCED ? 'reduce' : 'no-preference' },
    ],
  })

  await send('Page.navigate', { url: URL_ })

  // Readiness is polled: readyState complete AND a real element in the DOM. about:blank is never captured.
  await withTimeout(send('Runtime.evaluate', {
    expression: `new Promise((resolve) => {
      const deadline = Date.now() + 20000
      const tick = () => {
        const el = document.querySelector(${JSON.stringify(SELECTOR)})
        if (document.readyState === 'complete' && el) return resolve('ready')
        if (Date.now() > deadline) return resolve('timeout:' + document.readyState)
        setTimeout(tick, 50)
      }
      tick()
    })`,
    awaitPromise: true, returnByValue: true,
  }), TIMEOUT, 'page readiness')

  const ready = await send('Runtime.evaluate', {
    expression: `JSON.stringify({ title: document.title, readyState: document.readyState, hasSelector: !!document.querySelector(${JSON.stringify(SELECTOR)}), scrollHeight: document.documentElement.scrollHeight })`,
    returnByValue: true,
  })
  const pageInfo = JSON.parse(ready.result.value)
  if (!pageInfo.hasSelector) throw new Error(`selector ${SELECTOR} never appeared — refusing to capture a blank page`)

  if (SCROLL > 0) {
    await send('Runtime.evaluate', { expression: `window.scrollTo(0, ${SCROLL})`, awaitPromise: false })
    await sleep(150)
  }

  // Rendered boxes, not declared CSS and not a thumbnail: the census records eleven checks that graded one theme
  // and a capture too short that reported real content as missing. Measuring the live DOM is the only honest
  // source for "how big is this gap".
  const RECTS = arg('rects')
  if (RECTS) {
    const measured = await send('Runtime.evaluate', {
      expression: `(() => {
        const out = {};
        for (const sel of ${JSON.stringify(RECTS.split(',').map((x) => x.trim()))}) {
          const el = document.querySelector(sel);
          if (!el) { out[sel] = null; continue }
          const r = el.getBoundingClientRect();
          out[sel] = { top: Math.round(r.top + window.scrollY), bottom: Math.round(r.bottom + window.scrollY),
                       left: Math.round(r.left), right: Math.round(r.right),
                       width: Math.round(r.width), height: Math.round(r.height) };
        }
        out['__viewport'] = { width: window.innerWidth, height: window.innerHeight,
                             scrollHeight: document.documentElement.scrollHeight };
        return JSON.stringify(out);
      })()`,
      returnByValue: true,
    })
    const boxes = JSON.parse(measured.result.value)
    console.log(JSON.stringify(boxes, null, 2))
    if (!SHOTS.length) { client.close(); return }
  }

  const frames = []
  const startedAt = Date.now()
  let elapsed = 0
  for (const at of SHOTS) {
    if (at > elapsed) { await sleep(at - elapsed); elapsed = at }
    // `at` is the nominal offset; capturing a frame costs real time, so the honest moment is measured. A guard
    // reading this file for animation timing needs the difference, and a reader must not have to infer it.
    const actualMs = Date.now() - startedAt
    for (const click of CLICKS) {
      if (click.done || click.at > at) continue
      const out = await send('Runtime.evaluate', {
        expression: `(() => { const el = document.querySelector(${JSON.stringify(click.selector)}); if (!el) return 'MISSING'; el.click(); return 'clicked' })()`,
        returnByValue: true,
      })
      click.done = true
      console.log(`  click @${at}ms ${click.selector}: ${out.result?.value ?? 'no result'}`)
    }
    let evaluated = null
    if (EVAL) {
      const out = await send('Runtime.evaluate', { expression: EVAL, returnByValue: true, awaitPromise: true })
      evaluated = out.exceptionDetails === undefined
        ? out.result?.value ?? null
        : `EVAL ERROR: ${out.exceptionDetails.text} ${out.exceptionDetails.exception?.description ?? ''}`.trim()
      console.log(`  eval @${at}ms: ${typeof evaluated === 'string' ? evaluated : JSON.stringify(evaluated)}`)
    }
    const params = { format: 'png', captureBeyondViewport: false }
    if (FULL) {
      const metrics = await send('Page.getLayoutMetrics')
      const size = metrics.cssContentSize
      // Taller than the page on purpose: a capture cut at the fold has reported real content as missing.
      params.captureBeyondViewport = true
      params.clip = { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(size.height), scale: 1 }
    }
    const shot = await withTimeout(send('Page.captureScreenshot', params), TIMEOUT, `screenshot at ${at}ms`)
    const bytes = Buffer.from(shot.data, 'base64')
    const name = `${PREFIX}-${THEME}${REDUCED ? '-reduced' : ''}-${at}ms.png`
    const path = join(OUT, name)
    await writeFile(path, bytes)
    frames.push({
      file: name,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      atMs: at,
      actualMs,
      ...(EVAL ? { evaluated } : {}),
    })
    console.log(`  ${name}  ${bytes.length} bytes  sha ${frames.at(-1).sha256.slice(0, 16)}  (nominal ${at}ms, actual ${actualMs}ms)`)
  }

  await writeFile(join(OUT, 'manifest.json'), JSON.stringify({
    url: URL_,
    capturedAt: new Date().toISOString(),
    viewport: { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false },
    emulation: { colorScheme: THEME, reducedMotion: REDUCED ? 'reduce' : 'no-preference' },
    mode: HEADFUL ? 'headful (off-screen window)' : 'headless=new',
    fullPage: FULL,
    scrollY: SCROLL,
    page: pageInfo,
    ...(EVAL ? { evalExpression: EVAL } : {}),
    ...(CLICKS.length ? { clicks: CLICKS.map(({ selector, at }) => ({ selector, at })) } : {}),
    frames,
    proves: [
      'the page rendered at this viewport, in this colour scheme, at these moments',
      'layout at a glance: what is above the fold, what has wrapped or collided visibly',
    ],
    doesNotProve: [
      'real-device rendering, another browser, or a HiDPI screen',
      'any theme or reduced-motion mode not listed here — an unrendered mode is unverified',
      CLICKS.length ? `interaction: only the ${CLICKS.length} click(s) listed above were performed` : 'interaction: nothing was clicked, typed or dropped',
      'anything below the captured height, if --full was not used',
      'accessibility, contrast conformance, or that a control works',
      ...(EVAL ? ['anything about the page beyond the --eval expression that was actually run'] : []),
    ],
  }, null, 2))
  console.log(`  manifest: ${join(OUT, 'manifest.json')}`)
  client.close()
}

try {
  await main()
} catch (error) {
  console.error(`capture failed: ${error.message}`)
  process.exitCode = 1
} finally {
  killChrome()
}
