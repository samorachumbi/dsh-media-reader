/**
 * The hero walkthrough — the animation in the void the buy card leaves under the hero text.
 *
 * The defect this file exists to prevent is not "the animation looks wrong". It is the class of claim that
 * the page makes about itself and the DOM does not keep:
 *
 *   1. `hidden` that does not hide. The 900px media query sets `display: flex` on `.walkthrough`, which is an
 *      author rule and beats the `hidden` attribute's user-agent `display: none`. Without the paired
 *      `.walkthrough[hidden] { display: none }` the figure is visible at every width, stage empty.
 *   2. an animation that cannot be stopped. Every auto-playing surface needs Pause, Replay, an off-screen
 *      pause and a static reduced-motion path, and each has to be shown to work — not declared.
 *   3. text the artifact never produced. The walkthrough replays `DEMOS`, the same captured output the demo
 *      below carries; if a line on screen is not a line of that capture, it was invented.
 *   4. silent clipping. The stage is `overflow: hidden`, so anything too tall for it disappears without a
 *      trace. Lines are dropped by measurement here instead.
 *
 * The harness runs the page's OWN inline script in a stub DOM, so a behaviour described in prose but missing
 * from the code fails this file.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const repo = new URL('..', import.meta.url)
const PAGE = await readFile(new URL('store/index.html', repo), 'utf8')

// -----------------------------------------------------------------------------------------------------------
// the parts of the page this file needs
// -----------------------------------------------------------------------------------------------------------

const FIGURE_MATCH = /<figure class="walkthrough"[\s\S]*?<\/figure>/u.exec(PAGE)
assert.ok(FIGURE_MATCH !== null, 'store/index.html must carry the walkthrough figure')
const FIGURE = FIGURE_MATCH[0]

/**
 * The demo script block, with one deliberate surgical addition: `globalThis.__DEMOS = DEMOS` before the demo
 * wiring bails out. DEMOS is function-scoped inside that IIFE, and this file needs the captured text in order
 * to prove the animation only ever shows it.
 */
function demoScript() {
  const blocks = [...PAGE.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gu)].map((m) => m[1])
  const hits = blocks.filter((block) => block.includes('var DEMOS ='))
  assert.equal(hits.length, 1, 'exactly one inline script must define the captured DEMOS')
  const src = hits[0]
  const patched = src.replace(
    '  var buttons = Array.prototype.slice.call(',
    '  globalThis.__DEMOS = DEMOS;\n  var buttons = Array.prototype.slice.call(',
  )
  assert.notEqual(patched, src, 'the DEMOS hand-off anchor has moved — update this test rather than relaxing it')
  return patched
}

function makeNode(attrs = {}) {
  const node = {
    attrs: { ...attrs },
    children: [],
    disabled: false,
    hidden: Object.prototype.hasOwnProperty.call(attrs, 'hidden'),
    clientHeight: 0,
    text: '',
    handlers: Object.create(null),
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null
    },
    setAttribute(name, value) { this.attrs[name] = String(value) },
    removeAttribute(name) { delete this.attrs[name] },
    hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) },
    appendChild(child) { this.children.push(child); return child },
    removeChild(child) {
      const at = this.children.indexOf(child)
      assert.notEqual(at, -1, 'removeChild was called with a node that is not a child')
      this.children.splice(at, 1)
      return child
    },
    addEventListener(type, fn) { (this.handlers[type] ??= []).push(fn) },
    fire(type, event = {}) { for (const fn of this.handlers[type] ?? []) fn(event) },
    querySelector(selector) { return findDeep(this, selector) },
  }
  Object.defineProperty(node, 'textContent', {
    get() { return this.text },
    set(value) {
      this.text = String(value)
      if (this.text === '') this.children.length = 0 // as in a real DOM: assigning '' removes the children
    },
  })
  return node
}

/**
 * Selector resolution is deliberately strict. A stub that quietly matches nothing turns every assertion in
 * this file into a tautology, so an unsupported selector is an error, not a null.
 */
function matches(node, selector) {
  const m = /^\[([a-z0-9-]+)(?:="([^"]*)")?\]$/iu.exec(selector)
  assert.ok(m !== null, `stub cannot resolve selector ${selector} — extend it deliberately`)
  const value = node.getAttribute(m[1])
  return m[2] === undefined ? value !== null : value === m[2]
}

function findDeep(node, selector) {
  for (const child of node.children) {
    if (matches(child, selector)) return child
    const hit = findDeep(child, selector)
    if (hit !== null) return hit
  }
  return null
}

/** The figure's nodes are built from the shipped markup, so a renamed data attribute fails here at once. */
function figureNodes() {
  const nodes = []
  for (const tag of FIGURE.matchAll(/<([a-z]+)([^>]*)>/gu)) {
    const [, name, raw] = tag
    if (name === 'figure') continue
    const attrs = {}
    for (const a of raw.matchAll(/([a-z][a-z0-9-]*)(?:="([^"]*)")?/gu)) attrs[a[1]] = a[2] ?? ''
    const wanted = ['data-walk-stage', 'data-walk-file', 'data-walk-tool', 'data-walk-out', 'data-walk']
    if (!wanted.some((key) => Object.prototype.hasOwnProperty.call(attrs, key))) continue
    nodes.push(makeNode(attrs))
  }
  return nodes
}

// -----------------------------------------------------------------------------------------------------------
// the harness
// -----------------------------------------------------------------------------------------------------------

function harness({
  wide = true,
  reduced = false,
  stageHeight = 240,
  boxHeight = 360,
  baseScroll = 40,
  lineHeight = 18,
} = {}) {
  const flags = { wide, reduced }
  const box = makeNode({ class: 'walkthrough', id: 'walkthrough', hidden: '' })
  box.children.push(...figureNodes())
  box.clientHeight = boxHeight

  const stageEl = box.querySelector('[data-walk-stage]')
  const outEl = box.querySelector('[data-walk-out]')
  stageEl.clientHeight = stageHeight
  // the stage scrolls by its content, which is how overflow (and therefore silent clipping) is detectable
  Object.defineProperty(stageEl, 'scrollHeight', {
    configurable: true,
    get: () => baseScroll + outEl.children.length * lineHeight,
  })

  const clock = { now: 0, seq: 0, queue: new Map() }
  const setTimeoutStub = (fn, ms = 0) => {
    const id = ++clock.seq
    clock.queue.set(id, { fn, at: clock.now + ms })
    return id
  }
  const clearTimeoutStub = (id) => { clock.queue.delete(id) }

  function runDue(target) {
    for (;;) {
      const due = [...clock.queue.entries()]
        .filter(([, entry]) => entry.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])
      if (due.length === 0) break
      const [id, entry] = due[0]
      clock.queue.delete(id)
      clock.now = entry.at
      entry.fn()
    }
    clock.now = Math.max(clock.now, target)
  }

  const observers = []
  class IntersectionObserverStub {
    constructor(callback) { this.callback = callback; this.targets = []; observers.push(this) }
    observe(target) { this.targets.push(target) }
    intersect(isIntersecting, ratio = isIntersecting ? 0.6 : 0) {
      this.callback([{ isIntersecting, intersectionRatio: ratio, target: this.targets[0] }])
    }
  }

  const documentHandlers = Object.create(null)
  const windowHandlers = Object.create(null)
  const doc = {
    hidden: false,
    getElementById: (id) => (id === 'walkthrough' ? box : null),
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag) => makeNode({ 'data-tag': tag }),
    addEventListener(type, fn) { (documentHandlers[type] ??= []).push(fn) },
    fire(type, event = {}) { for (const fn of documentHandlers[type] ?? []) fn(event) },
  }
  const win = {
    matchMedia(query) {
      const width = /min-width:\s*(\d+)px/u.exec(query)
      if (width !== null) return { matches: flags.wide && Number(width[1]) <= 900 }
      if (/prefers-reduced-motion/u.test(query)) return { matches: flags.reduced }
      throw new Error(`stub matchMedia has no rule for "${query}"`)
    },
    addEventListener(type, fn) { (windowHandlers[type] ??= []).push(fn) },
    fire(type, event = {}) { for (const fn of windowHandlers[type] ?? []) fn(event) },
  }

  const context = vm.createContext({
    document: doc,
    window: win,
    IntersectionObserver: IntersectionObserverStub,
    setTimeout: setTimeoutStub,
    clearTimeout: clearTimeoutStub,
  })
  vm.runInContext(demoScript(), context, { filename: 'store/index.html' })

  const shownCount = () => outEl.children.filter((child) => child.hasAttribute('data-shown')).length

  return {
    box,
    stageEl,
    outEl,
    doc,
    win,
    flags,
    clock,
    observers,
    demos: vm.runInContext('__DEMOS', context),
    fileEl: box.querySelector('[data-walk-file]'),
    toolEl: box.querySelector('[data-walk-tool]'),
    pauseBtn: box.querySelector('[data-walk="pause"]'),
    replayBtn: box.querySelector('[data-walk="replay"]'),
    state: () => box.getAttribute('data-walk-state'),
    shown: shownCount,
    lines: () => outEl.children.map((child) => child.textContent),
    intersect: (on, ratio) => { for (const observer of observers) observer.intersect(on, ratio) },
    /** Advance virtual time, sampling whatever the operator would see at each step. */
    advance(ms, sample) {
      const end = clock.now + ms
      while (clock.now < end) {
        runDue(Math.min(clock.now + 50, end))
        if (sample !== undefined) sample()
      }
    },
  }
}

// -----------------------------------------------------------------------------------------------------------
// tests
// -----------------------------------------------------------------------------------------------------------

test('the walkthrough is wired to the markup the page actually ships', () => {
  for (const key of ['data-walk-stage', 'data-walk-file', 'data-walk-tool', 'data-walk-out']) {
    assert.ok(FIGURE.includes(key), `the figure must carry ${key}`)
  }
  assert.match(FIGURE, /data-walk="pause"[^>]*aria-pressed="false"/u, 'Pause must start unpressed')
  assert.match(FIGURE, /data-walk="replay"/u, 'Replay must exist')
  assert.match(FIGURE, /href="#demo"/u, 'the only call to action points at the real demo')
  assert.match(PAGE, /\.walkthrough\[hidden\] \{ display: none; \}/u,
    'the hidden attribute must beat the 900px display:flex rule, or the figure is visible at every width')
})

test('the figure stays away where there is no room for it', () => {
  const narrow = harness({ wide: false })
  assert.equal(narrow.box.hidden, true, 'below 900px the hero is one column and there is nothing to fill')
  assert.equal(narrow.observers.length, 0, 'no room means no animation, not a hidden one still running')

  const short = harness({ stageHeight: 40 })
  assert.equal(short.box.hidden, true, 'a stage too short for three lines would be a sliver')
  assert.equal(short.box.getAttribute('data-walk-unsized'), '40', 'the measured height must be recorded')
  assert.equal(short.clock.queue.size, 0, 'nothing may be scheduled for a figure that never showed')
})

test('armed, then it plays all three captured files in order and stops', () => {
  const h = harness()
  assert.equal(h.box.hidden, false, 'the figure shows where the hero leaves room')
  assert.equal(h.state(), 'ready', 'an armed figure is not a playing one')
  assert.equal(h.fileEl.textContent, '[media: hello.png]', 'the first file label is on screen before it plays')
  assert.equal(h.toolEl.textContent, 'media_image \u00b7 2.0 s', 'the tool and its measured time come from the capture')
  assert.equal(h.shown(), 0, 'no output line is revealed until it plays')

  h.intersect(true)
  assert.equal(h.state(), 'playing', 'a quarter on screen starts it')

  const order = []
  h.advance(30000, () => {
    const label = h.fileEl.textContent
    if (order.at(-1) !== label) order.push(label)
  })

  assert.deepEqual(order, ['[media: hello.png]', '[media: jfk.wav]', '[media: error-demo.mp4]'],
    'the image, the audio and the video, in that order — all three media types, not just the image')
  assert.equal(h.state(), 'done', 'it ends rather than looping')
  assert.equal(h.pauseBtn.disabled, true, 'nothing is moving, so Pause is honestly unavailable')
  assert.equal(h.shown(), h.outEl.children.length, 'the last beat is left complete on screen')

  h.intersect(false)
  h.intersect(true)
  assert.equal(h.state(), 'done', 'autoplay is once: coming back into view does not restart a finished run')
  assert.equal(h.fileEl.textContent, '[media: error-demo.mp4]', 'and it does not rewind either')
})

test('pausing works from the button, from the viewport edge, and from a hidden tab', () => {
  const button = harness()
  button.intersect(true)
  button.advance(600)
  const before = button.shown()
  button.pauseBtn.fire('click')
  assert.equal(button.state(), 'paused', 'Pause must change the state it reports')
  assert.equal(button.pauseBtn.textContent, 'Play', 'and offer the way back')
  button.advance(5000)
  assert.equal(button.shown(), before, 'a paused walkthrough reveals nothing')
  button.pauseBtn.fire('click')
  assert.equal(button.state(), 'playing', 'Play resumes it')
  button.advance(30000)
  assert.equal(button.state(), 'done')

  const viewport = harness()
  viewport.intersect(true)
  viewport.advance(600)
  const shownOffscreen = viewport.shown()
  viewport.intersect(false)
  assert.equal(viewport.state(), 'paused', 'leaving the viewport pauses it')
  viewport.advance(5000)
  assert.equal(viewport.shown(), shownOffscreen, 'and it does not run on out of sight')
  viewport.intersect(true)
  assert.equal(viewport.state(), 'playing', 'returning resumes rather than restarts')
  viewport.advance(30000)
  assert.equal(viewport.state(), 'done')

  const tab = harness()
  tab.intersect(true)
  tab.advance(600)
  const shownHidden = tab.shown()
  tab.doc.hidden = true
  tab.doc.fire('visibilitychange')
  assert.equal(tab.state(), 'paused', 'a hidden tab pauses it')
  tab.advance(5000)
  assert.equal(tab.shown(), shownHidden, 'a hidden tab animates nothing')
})

test('a pause the operator chose is not undone by scrolling', () => {
  const h = harness()
  h.intersect(true)
  h.advance(600)
  h.pauseBtn.fire('click')
  h.intersect(false)
  h.intersect(true)
  assert.equal(h.state(), 'paused', 'my pause outranks the viewport observer')
  h.advance(5000)
  assert.equal(h.state(), 'paused')
})

test('a window that is narrow now and wide later still gets the walkthrough', () => {
  const h = harness({ wide: false })
  assert.equal(h.box.hidden, true, 'narrow to begin with, so it stays away')
  assert.equal(h.observers.length, 0, 'and nothing is watching for it')

  h.flags.wide = true
  h.win.fire('resize')
  h.advance(200)
  assert.equal(h.box.hidden, false, 'widening must reveal it rather than leave it stranded')
  assert.equal(h.state(), 'ready', 'armed on the resize, still not moving')
  assert.equal(h.observers.length, 1, 'and now observed')
  h.intersect(true)
  assert.equal(h.state(), 'playing')
})

test('Replay starts the sequence again from the first file', () => {
  const h = harness()
  h.intersect(true)
  h.advance(30000)
  assert.equal(h.state(), 'done')
  h.replayBtn.fire('click')
  assert.equal(h.state(), 'playing', 'Replay restarts the run')
  assert.equal(h.fileEl.textContent, '[media: hello.png]', 'back to the first file')
  assert.equal(h.shown(), 0, 'and the output starts over rather than stacking')
  assert.equal(h.pauseBtn.disabled, false, 'Pause is available again')
  h.advance(30000)
  assert.equal(h.state(), 'done')
})

test('reduced motion moves nothing, and still shows all three files', () => {
  const h = harness({ reduced: true })
  assert.equal(h.clock.queue.size, 0, 'no timers at all under prefers-reduced-motion')
  assert.equal(h.state(), 'static', 'a still frame is not a paused animation')
  assert.equal(h.pauseBtn.hidden, true, 'nothing is moving, so Pause is not offered')
  assert.equal(h.replayBtn.textContent, 'Next file', 'the one remaining control says what it does')
  assert.equal(h.fileEl.textContent, '[media: hello.png]', 'it starts at the first capture')
  assert.equal(h.shown(), h.outEl.children.length, 'whose lines are all visible at once')
  assert.ok(h.outEl.children.length > 0, 'and it is not empty')

  const seen = [h.fileEl.textContent]
  for (let i = 0; i < 3; i += 1) {
    h.replayBtn.fire('click')
    assert.equal(h.clock.queue.size, 0, 'stepping schedules nothing')
    assert.equal(h.shown(), h.outEl.children.length, 'each still arrives complete')
    seen.push(h.fileEl.textContent)
  }
  assert.deepEqual(seen, [
    '[media: hello.png]', '[media: jfk.wav]', '[media: error-demo.mp4]', '[media: hello.png]',
  ], 'every capture is reachable without motion, and the last click wraps to the first')
})

test('nothing is clipped, and every line on screen is a line the capture produced', () => {
  const tight = harness({ stageHeight: 70, baseScroll: 40, lineHeight: 18 })
  const roomy = harness()
  // Derived, never a literal: this assertion said "dropped 2" and silently became wrong the moment a beat gained
  // a line. A guard that hard-codes the number it is checking stops being about the behaviour.
  assert.ok(tight.outEl.children.length < roomy.outEl.children.length,
    'the tight stage must drop lines rather than hide them under the edge')
  assert.ok(tight.outEl.children.length >= 1, 'but it must never drop all of them')
  const dropped = Number(tight.box.getAttribute('data-walk-trim'))
  assert.ok(Number.isInteger(dropped) && dropped > 0, 'and it records how many it dropped')
  assert.equal(dropped, roomy.outEl.children.length - tight.outEl.children.length,
    'the recorded count must match what is actually missing')
  assert.equal(tight.outEl.children[0].textContent, roomy.outEl.children[0].textContent,
    'trimming takes from the tail, so the first line always survives')
  assert.ok(40 + tight.outEl.children.length * 18 <= 71, 'what is left fits the stage it was measured against')

  const wide = harness()
  wide.intersect(true)
  wide.advance(30000)
  const tightStage = harness({ stageHeight: 70, baseScroll: 40, lineHeight: 18 })

  for (const h of [harness(), harness({ reduced: true }), wide, tightStage]) {
    const captured = Object.values(h.demos).flatMap((demo) => demo.body.split('\n'))
    for (const line of h.lines()) {
      assert.ok(captured.includes(line),
        `the walkthrough may only show captured output; "${line}" is not a line of DEMOS`)
    }
  }
})
