# DSH modality contract — pinned

**Pinned:** 2026-10-30 · **Against:** DSH `0.1.1-rc.2`, `@deepseek-ai/dsh-tools` `0.1.1-rc.2`
**Root:** `dsh/` = `/home/samora/.nvm/versions/node/v24.20.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`

Re-verify by re-reading these lines. If upstream moves, the diff between this file and the tree **is**
the finding.

## 1. Modalities

```js
// dsh-llm-deepseek/lib/index.js:1612
const MODEL_MODALITIES = ["text", "image"];
```

**No audio, video or file modality exists.** Audio and video can never reach a model through DSH; they
must be converted to text (and video additionally to images).

Catalog (`dsh-llm-deepseek/lib/index.js:1595-1608`):

| Model | `inputModalities` |
|---|---|
| `deepseek-v4-flash` | absent → schema default `["text"]` |
| `deepseek-v4-pro` | absent → schema default `["text"]` |
| `deepseek-v4-flash-vision-exp` | `["text","image"]`, `imagePixelBudget: 640000`, `imageMaxBytes: 1048576` |

Configured default route (`~/.dsh/settings.yaml`): `deepseek-official / deepseek-v4-flash-vision-exp`.
Configured second provider: `k3` (Kimi) via `dsh-llm-pi-ai` — text-only, foreign route.

## 2. The failure we exist to fix

```js
// dsh-llm/lib/index.js:592-594
function textOnlyImageText(ref) {
  return `[image omitted because this model accepts text only; attachment sha256:${String(ref.attachmentId).slice(7, 15)}]`;
}
```

Applied in `adapterStream` (`dsh-llm/lib/index.js:1585`) whenever
`info.inputModalities !== undefined && !info.inputModalities.includes("image")` and any message carries
an image block (`projectImagesForTextModel`, `:685`). Note: `inputModalities === undefined` **passes**
this gate.

## 3. All four gates on image access

| Gate | Location | Behaviour |
|---|---|---|
| tool | `dsh-tool-fs/lib/index.js:941` | `read_image` throws `cannot read "…" as an image: model "…" does not declare image input; switch to an image-capable model to read images` |
| runtime projection | `dsh-llm/lib/index.js:1585` | image block replaced by the placeholder above |
| attachment admission | `dsh-host-apiproxy/lib/index.js:2755` | user-attached image on a text-only route → `attachment-error` / `MODEL_DOES_NOT_SUPPORT_IMAGES`, refused pre-session |
| adapter | `dsh-llm-deepseek/lib/index.js:1396` | `LlmError("… does not accept image input.", "UNSUPPORTED_CONTENT")` |

## 4. Image size limits

| Limit | Request (`dsh-llm-deepseek`) | Store (`dsh-attachment-local/lib/index.js:833-838`) |
|---|---|---|
| bytes | 1 MiB (`:1167`) | 20 MiB |
| pixels | 640 000 (`:1163`) | 64 Mpx |
| per side | — | 8192 px |

## 5. Extension seams (typed, used by first-party packages)

| Seam | File:line | Can it replace what the model sees? |
|---|---|---|
| `tools/post-execute` → `PostToolDecision{kind:'accept', content?}` | `dsh-tools/lib/types/index.d.ts:61`, `:431`; implementation `dsh-tools/lib/index.js:3360-3394` | can replace content, **but preserves `isError`/`error`**; replacing `value` on a failed result throws (`:3381`). Not a failure→success fallback |
| `tools/pre-execute` → `{allow,deny,ask}` | `:38`, `:418`; denial `dsh-tools/lib/index.js:3109-3125` | cannot supply a result, but `deny.reason` becomes model-visible `Error: …` — suitable for a corrective redirect |
| `tools/execute` | `:49`; normalization `dsh-tools/lib/index.js:3436-3451` | around-dispatch wrapper; a synthetic success is normalized through the **owning tool's** output schema/renderer, so it cannot turn `read_image` into arbitrary text |
| `agent/request` → `{provider, model, …}` | `dsh-agent-loop/lib/index.js:708` | route only, not messages |
| `agent/request-error` → `{kind:'retry'}` | `dsh-agent-loop/lib/index.js:653` | retry only |
| `agent/pre-step` → `{kind:'enter', messages}` | `dsh-agent/lib/types/runtime-types.d.ts:235` | injects messages before a step |
| `llm/stream` → `AsyncIterable<StreamChunk>` | `dsh-llm/lib/types/index.d.ts:43`, call site `:1640` | **NO** — `next` is bound to the original options; it is a stream transformer, not a request rewrite |

## 6. Service surface a plugin may use

| Service | Use | Evidence |
|---|---|---|
| `ctx.tools.register(defineTool({…}))` | tool registration | `dsh-tool-fs/lib/index.js:1005-1105` |
| `ctx.llm.stream(GenerateOptions)` | auxiliary model call (`purpose` must stay unset — closed union `'compaction' \| 'session-title'`) | `dsh-session-title-llm/lib/index.js:208-228`; `dsh-llm/lib/types/types.d.ts:367` |
| `ctx.llm.resolveModelInfo(provider, model)` | the route-capability check | `dsh-tool-fs/lib/index.js:925-943` |
| `ctx.attachments.saveImage({data, mediaType, name})` | mint an image block | `dsh-attachment/lib/types/index.d.ts:49` |
| `ctx.subprocess.spawn(spec)` | run `ffmpeg`/`ffprobe` | `dsh-subprocess/lib/types/index.d.ts:91` |
| `ctx.fs.resolve` / `stat` / `readBytes` | safe input resolution and bounded image reads | `dsh-tool-fs/lib/index.js:273-285`, `:1037-1045` |
| `ctx.fs.processPath(target)` | canonical absolute path for ffmpeg argv; local backend returns `String(target.targetKey)` | `dsh-fs/lib/types/index.d.ts:88-97`; `dsh-fs-local/lib/index.js:713-715` |
| image block shape | `{type:'image', attachment: {attachmentId, mediaType, bytes, width, height}}` | `dsh-tool-fs/lib/index.js` `imageReadContent` |

## 7. Installation contract

`dsh plugin --profile <p> …` forwards to **pnpm** inside the profile (re-confirmed 2026-10-30: it printed
pnpm's own help). That is the known split-Symbol crash vector. **Install by copy-restore:**
`cp -r <plugin> ~/.dsh/profiles/web/node_modules/<name>` + one `cordis.patch.yml` insert row.

## 8. Limits this plugin cannot cross

1. No audio modality → audio is always text.
2. No request-rewrite seam → automatic help must be a **redirect** on `tools/pre-execute`. A
   `post-execute` content replacement leaves the result failed, and a `tools/execute` synthetic success
   is normalized through the owning tool's schema. Neither can turn a failed `read_image` into a clean
   text success.
3. A **user-attached** image on a text-only route is refused before the plugin is ever reached.
4. Non-speech audio has no route through DSH at all.
