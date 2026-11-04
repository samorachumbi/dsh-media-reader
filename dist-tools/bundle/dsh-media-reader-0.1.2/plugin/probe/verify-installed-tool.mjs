/**
 * Execute the INSTALLED plugin's media_evidence tool through a harness-shaped
 * context, so the proof is about the artifact in the profile, not the repo.
 *
 *   node probe/verify-installed-tool.mjs [path-to-installed-lib/index.js] [media-file]
 *
 * Kept in the repo on purpose: it lived in /tmp during the 2026-10-31 session and
 * would have been lost with the next reboot, while it is the only check that
 * proves the tool registered and ran in the *installed* copy rather than in the
 * working tree.
 *
 * The fake context implements only what the tool path touches: a tool registry,
 * a filesystem view, and a subprocess service whose spawn() delegates to
 * child_process with the same handle shape @deepseek-ai/dsh-subprocess uses
 * (`done` + `collected.stdout.readFrom(0).text`).
 */
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

import { existsSync } from 'node:fs'

// No machine path is baked in: the installed copy is discovered from DSH_HOME, or passed explicitly.
const HOME = process.env.HOME ?? ''
const DSH_HOME = process.env.DSH_HOME ?? `${HOME}/.dsh`
const PROFILE = process.env.DSH_PROFILE ?? 'web'
const pick = (candidates) => candidates.find((candidate) => candidate && existsSync(candidate))
const DEST = process.argv[2] ?? pick([
  `${DSH_HOME}/profiles/${PROFILE}/node_modules/dsh-media-reader/lib/index.js`
])
const FIXTURE = process.argv[3] ?? pick([
  new URL('../fixtures/error-demo.mp4', import.meta.url).pathname
])
if (!DEST) {
  console.error('usage: verify-installed-tool.mjs <installed lib/index.js> [media-file]')
  console.error('       no default found under $DSH_HOME/profiles/<profile>/node_modules/dsh-media-reader')
  process.exit(2)
}

function subprocessService() {
  return {
    spawn({ argv, cwd, stdio, signal }) {
      const child = spawn(argv[0], argv.slice(1), { cwd, stdio: ['ignore', 'pipe', 'pipe'], signal })
      const out = []
      const err = []
      child.stdout.on('data', (chunk) => out.push(chunk))
      child.stderr.on('data', (chunk) => err.push(chunk))
      const cap = stdio?.stdout?.maxBytes ?? 8 * 1024 * 1024
      const read = (chunks) => ({
        readFrom() {
          const text = Buffer.concat(chunks).toString('utf8')
          return { text: text.length > cap ? text.slice(-cap) : text, bytes: Buffer.byteLength(text) }
        }
      })
      return {
        done: new Promise((resolve) => child.on('close', (exitCode) => resolve({ exitCode }))),
        collected: { stdout: read(out), stderr: read(err) }
      }
    }
  }
}

const tools = new Map()
const ctx = {
  tools: { register: (definition) => { tools.set(definition.name, definition); return () => tools.delete(definition.name) } },
  fs: {
    resolve: async (requested) => ({ targetKey: requested, displayPath: requested }),
    stat: async () => ({ type: 'file', size: 110304 }),
    processPath: (target) => target.targetKey
  },
  get: (name) => (name === 'subprocess' ? subprocessService() : undefined),
  on: () => () => {}
}

const plugin = await import(pathToFileURL(DEST).href)
plugin.apply(ctx, { sttModel: 'base', replicationDir: '/tmp/evidence-tool-check' })

if (!tools.has('media_evidence')) {
  console.error('FAIL: media_evidence is not registered by the installed plugin')
  process.exit(1)
}
const definition = tools.get('media_evidence')
console.log('registered tools:', [...tools.keys()].sort().join(', '))
console.log('declared timeoutMs:', definition.timeoutMs, '| concurrency safe:', definition.isConcurrencySafe?.())

const started = Date.now()
const text = await definition.execute(
  { path: FIXTURE, mode: 'transform', shots: 2, lyrics: false },
  { name: 'media_evidence', arguments: { path: FIXTURE }, agent: { options: {} }, signal: new AbortController().signal }
)
console.log(`--- tool returned in ${Date.now() - started} ms ---`)
console.log(text)
