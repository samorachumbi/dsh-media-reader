# Research — Video / Image / Voice reading plugin for DeepSeek Harness

**Date:** 2026-10-30 · **Status:** research complete, audited same day; no implementation · **Author:** agent session
**Project:** [[video-image-voice-plugin]] (`7aa517dd-094b-4af2-bba7-f57a1c50190e`)

> **Audit errata (2026-10-30):** see `AUDIT.md` and `PLAN.md` v2. Two statements here are superseded:
> D3's post-execute fallback cannot turn a failed `read_image` into a success (use a pre-execute
> redirect), and video presentation is now route-aware on every route, not description-first.

> Every claim below is tagged: **[verified]** = read in code/metadata/registry on this machine today,
> with the file or URL named. **[claimed]** = a third party's own statement, not verified by us.
> **[unmeasured]** = believed true, test not yet run.

---

## 1. The goal, stated so it can fail

**Goal:** any LLM connected to this harness — including a text-only model that cannot accept images or
audio at all — can interpret a **video**, an **image** and a **voice/audio recording** by invoking this
plugin's tools, and the answer is always traceable to a real read of the real file.

Three properties make that a real goal rather than a slogan:

1. **It must work on the worst model.** A vision-capable model reading an image is not the interesting
   case; the interesting case is `deepseek-v4-flash`, which cannot.
2. **It must never invent.** A missing dependency, an unreadable file, or an absent speech track must
   produce an explicit failure or an explicit "not present", never a plausible-sounding observation.
3. **It must say where the answer came from.** Source path, processor, timing, and what was skipped.

## 2. What the harness actually does today (the gap, measured)

This is the part the whole design hangs on. Verified in the installed harness at
`dsh/` = `$HOME/.nvm/versions/node/v24.20.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`
(DSH **0.1.1-rc.2**, `dsh-tools` **0.1.1-rc.2**).

### 2.1 There are only two modalities. Audio does not exist in the protocol. **[verified]**

```js
// dsh-llm-deepseek/lib/index.js:1612
const MODEL_MODALITIES = ["text", "image"];
```

There is no `audio`, `video` or `file` modality anywhere in the model-content model. **Consequence:**
audio and video can never be *sent* to a model through DSH. They must always be converted — video to
images + text, audio to text. This is not a limitation we work around; it is the shape of the product.

### 2.2 When a text-only model meets an image, it does not fail — it gets a dead placeholder. **[verified]**

```js
// dsh-llm/lib/index.js:592-594
function textOnlyImageText(ref) {
  return `[image omitted because this model accepts text only; attachment sha256:${String(ref.attachmentId).slice(7, 15)}]`;
}
```

and the runtime applies it on every request:

```js
// dsh-llm/lib/index.js:1585  (inside adapterStream)
const projectedOptions = modelInfo.inputModalities !== void 0
  && !modelInfo.inputModalities.includes("image")
  && resolvedOptions.messages.some(m => contentHasImage(m.content))
    ? { ...resolvedOptions, messages: projectImagesForTextModel(resolvedOptions.messages) }
    : resolvedOptions;
```

**This is the exact hole the plugin fills.** Today the agent is told an image exists and was dropped;
nothing converts it. Downstream, the placeholder is unrecoverable — the model cannot even ask a
follow-up because it never saw the pixels.

### 2.3 Three independent gates decide what a given route may see **[verified]**

| Gate | Where | Behaviour |
|---|---|---|
| Tool gate | `dsh-tool-fs/lib/index.js:941` | `read_image` **throws**: `cannot read "x" as an image: model "…" does not declare image input; switch to an image-capable model to read images` |
| Runtime projection | `dsh-llm/lib/index.js:1585` | image block → `[image omitted …]` text |
| Attachment admission | `dsh-host-apiproxy/lib/index.js:2755` | a **user-attached** image on a text-only route is refused before it enters the session: `Model "…" does not support image input.` (`MODEL_DOES_NOT_SUPPORT_IMAGES`) |
| Adapter belt-and-braces | `dsh-llm-deepseek/lib/index.js:1396` | `LlmError(… "does not accept image input.", "UNSUPPORTED_CONTENT")` |

All four key off the same fact: `llm.resolveModelInfo(provider, model).inputModalities.includes("image")`.
Note the asymmetry at gate 2/3: `inputModalities === undefined` **passes** the projection gate (images
would be sent through) but **fails** the `read_image` gate. Only the vision model declares image input
positively.

### 2.4 The catalog on this machine **[verified]**

```js
// dsh-llm-deepseek/lib/index.js:1595-1608
{ id: "deepseek-v4-flash" }              // inputModalities absent → schema default ["text"]
{ id: "deepseek-v4-pro" }                // same
{ id: "deepseek-v4-flash-vision-exp", inputModalities: ["text","image"],
  imagePixelBudget: 640_000, imageMaxBytes: 1_048_576 }
```

`~/.dsh/settings.yaml` sets `agent-default-model: deepseek-official / deepseek-v4-flash-vision-exp`, so
**the default session route can already see images**. The text-only negative control is therefore free:
`deepseek-v4-flash` on the **same provider and API key**. No second credential is needed to prove the
fallback works. A second provider (`k3`/Kimi via `dsh-llm-pi-ai`) is also configured, useful as a
foreign text-only route.

Image limits a frame must respect: **≤ 1 MB**, **≤ 640 000 px** request budget (`/index.js:1163-1167`),
while the attachment store accepts up to 20 MB / 64 Mpx / 8192 px per side
(`dsh-attachment-local/lib/index.js:833-838`). So the harness downscales rather than refuses — but
downscaling costs fidelity on small on-screen text, so frames should be generated inside the budget.

### 2.5 The extension seams that exist — and the one that does not **[verified]**

A DSH plugin is cordis code in the host process. These waterfalls are real, typed, and used by shipped
first-party packages:

| Seam | Signature | What it buys us |
|---|---|---|
| `tools/post-execute` | `(exec, result, next) → PostToolDecision` (`dsh-tools/lib/types/index.d.ts:61`) | **replace one tool result's model-facing content**, including injecting image blocks (`{kind:'accept', content?: ContentBlock[]}`, `:431-445`) |
| `tools/pre-execute` | `(exec, next) → {allow|deny|ask}` (`:38`) | cannot substitute a result — allow/deny/ask only |
| `tools/execute` | `(exec, next) → ToolExecutionResult` (`:49`) | around-dispatch wrapper for timeout/retry; may change only `exec.signal` |
| `agent/request` | `(payload, next) → {provider, model, …}` (`dsh-agent-loop/lib/index.js:708`) | change the **route** of a request |
| `agent/request-error` | `(payload, next) → {kind:'retry'} \| undefined` (`dsh-agent-loop/lib/index.js:653`) | retry after a classified failure |
| `agent/pre-step` | `(payload, next) → {kind:'enter'\|'reject', messages}` (`dsh-agent/lib/types/runtime-types.d.ts:235`) | inject messages before a step (this is how the time-context plugin works) |
| `llm/stream` | `(options, next) → AsyncIterable<StreamChunk>` (`dsh-llm/lib/types/index.d.ts:43`) | **stream transformer only** — `next` is already bound to the original options (`dsh-llm/lib/index.js:1640`), so a listener **cannot rewrite the request** |
| `system-prompt/assemble` | `(assembly, context, next)` | add prompt sections |

**Correction to an assumption worth recording:** `llm/stream` looks like a request-rewrite seam and is
not one. The only place a plugin can *replace content the model sees* is `tools/post-execute`. Therefore
**automatic interception must be built on the tool path, not the model path** (see §5.3).

### 2.6 A plugin can call a model itself **[verified]**

`dsh-session-title-llm/lib/index.js:208-228` is working precedent for an auxiliary call:

```js
const options = deepFreeze({ provider, model, messages, system, maxTokens, sessionId, signal })
const assembler = new BlockAssembler()
for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)
```

`GenerateOptions.purpose` is a closed union (`'compaction' | 'session-title'`, `dsh-llm/lib/types/types.d.ts:367`)
— auxiliary media calls must leave it **unset**. `ctx.subprocess.spawn(spec)`
(`dsh-subprocess/lib/types/index.d.ts:91`) is the sanctioned way to run `ffmpeg`; `ctx.attachments.saveImage`
(`dsh-attachment/lib/types/index.d.ts:49`) is how a plugin mints an image block. `read_image` itself is a
60-line template for both (`dsh-tool-fs/lib/index.js:1005-1105`).

**[unmeasured]** whether a nested `ctx.llm.stream()` **from inside a tool's `execute`** is safe while the
agent loop is awaiting that tool. Precedent exists for side-channel calls, none for a nested one inside
tool dispatch. This is the first probe in the plan, not an assumption.

## 3. Prior art (found before building — the standing rule)

Registry data read today from `registry.npmjs.org`; artifact scans run on the downloaded tarballs.

| Package | Version / age | Surface | Scan | Verdict |
|---|---|---|---|---|
| [`dsh-video-lens`](https://www.npmjs.com/package/dsh-video-lens) (`dundunhan`) | 0.3.2, 2 versions, created 2026-08-18 | `video_probe`, `video_analyze`, `video_ask` — ffmpeg `scdet` frames + HTTP VLM + optional HTTP ASR → evidence JSON | MIT; 20 KB; deps: schemastery only; `execFile` argv arrays (no shell); one hard-coded default host `api.siliconflow.cn`; keys from env at call time; no eval/telemetry; self-authored `SECURITY.md` with a threat table | **Closest prior art.** [claimed] "text-only agents get video understanding". Uses its **own** OpenAI-compatible VLM + ASR endpoints, so it needs a second key and cannot use DSH's configured model. Returns **text only** — never an image. |
| [`dsh-tool-describe-image`](https://www.npmjs.com/package/dsh-tool-describe-image) (`valleybobo`) | 0.5.1, 4 versions, 2026-08-13 | image → text via any OpenAI-compatible vision API, plus paste-to-describe and a desktop pet | dsh.bundle + dsh.client | Image only; separate vision key; the client half (pet + paste) is out of scope for us. |
| [`dsh-plugin-image-input`](https://www.npmjs.com/package/dsh-plugin-image-input) (`elohia`) | 0.1.1, **1 version**, 2026-08-15 | browser-side paste/drag → structured text description; "yields to multimodal models" | no runtime deps, client+bundle | The "yield to the native channel" idea is right and we adopt it. Single release, unvetted author, client-side. |
| `@deepseek-ai/dsh-experimental-client-ui-voice-input` | 0.1.7-alpha.1 (**first-party**) | record speech → text in the composer | — | **Different product**: talking *into* the harness. Not reading an audio file. |

**Not adopted, and why not:** all three are unvetted third parties (owner reputation, tests and
provenance unverified — `repo-vetting` has not been run on any of them). More importantly, none of them
does what §1 asks: **one plugin, three modalities, using the harness's own configured route, with local
speech-to-text and route-aware image passthrough.** `dsh-video-lens` remains the reference design for
scene sampling + fusion, and is re-read (not installed) before Phase 4.

## 4. What this machine can actually do — measured, not assumed

From the machine profile produced by the `machine-profile` skill (2026-09-25) and re-checked today:

| Fact | Value | Consequence |
|---|---|---|
| Tier | **T4-minimal** | strictest setting in the whole profile |
| CPU | i5-8265U, 4 cores / 8 threads, governor `powersave` | `small` int8 Whisper, `cpu_threads <= 4` |
| RAM | 7.6 GB total, **2.4 GB available** right now (Chrome running) | **one media job at a time, ever** |
| GPU | MX130 present, NVML fails | no GPU path; ignore it |
| Channel | single-channel (6.9 GB/s triad) | bandwidth-bound inference — `large-v3` is fiction here |
| `ffmpeg` / `ffprobe` | 6.1.1, `scdet` + `select` + `showinfo` present **[verified today]** | scene detection available |
| Python | 3.12.3, `python3 -m venv` works, `pip 24.0` in venv **[verified today]** | userspace STT install is possible |
| `faster-whisper` | **not installed**; PyPI reachable; version **1.2.1**, `requires_python >=3.9`, deps `ctranslate2>=4,<5`, `onnxruntime>=1.14`, `av>=11` **[verified today]** | ~600 MB venv + ~500 MB model, first run only |
| `sudo` | blocked | no `apt`; everything userspace |

**Unmeasured and decisive:** real-time factor of `faster-whisper small int8` on *this* CPU under *this*
power policy. The cited range for small/int8 on a 4-core laptop is roughly 1–3× real time; that is
[claimed], not measured. **The plan therefore gates the whole local-STT decision on a 60-second clip
measured in Phase 0**, with a pre-agreed fallback (see PLAN §0.3).

## 5. Decisions proposed (each with the reason and the cost)

### D1 — Audio always becomes text, locally, by default

DSH has no audio modality (§2.1), so this is forced. The choice is *where* transcription happens.
Local `faster-whisper` keeps private audio on the machine and needs no key; the cost is CPU time and
~1 GB of disk, and it fails on non-speech audio either way. **Local default, cloud escape hatch only if
the Phase 0 measurement fails** and the operator approves sending audio out.

### D2 — Image handling is route-aware: pass pixels when the model can see, describe when it cannot

Cheapest correct behaviour per route, resolved from `resolveModelInfo` (the same call `read_image`
uses):

- route declares `image` → the tool returns a real image block (attachment) **and** a short text
  envelope. Zero extra model calls; the model sees the actual pixels.
- route does not declare `image` → the tool calls the configured **vision route** via
  `ctx.llm.stream()` with the image block, and returns **text** carrying its own provenance.
- no vision route resolvable, or the call fails → **explicit error** naming exactly what is missing.

This is the single biggest differentiator against the prior art: no second API key, and no wasted
vision call for models that can already see.

### D3 — Automatic fallback attaches to the *tool* seam, not the model seam

Because `llm/stream` cannot rewrite a request (§2.5), the honest automatic behaviour is: a
`tools/post-execute` listener that catches a **failed `read_image`** on a text-only route and replaces
the error with a real description. Result: the model calls the tool it already knows, and gets an answer
instead of `does not declare image input`. User-attached images on a text-only route (§2.3, gate 3) are
**out of reach** without patching the host — that limit is documented, not papered over.

### D4 — One plugin, four tools, artifacts on disk

`media_probe` (metadata, no model call) · `media_image` (describe or pass through) · `media_audio`
(transcribe) · `media_video` (shot frames + fused timeline). Long output goes to files; the tool result
carries a bounded digest plus artifact paths. This follows the artifact contract already fixed in
`~/projects/multimodal-reader/BRIEF.md` §6 rather than inventing a second one.

### D5 — Coarse-to-fine is a hard rule, not a preference

On T4 with 2.4 GB free RAM: one contact sheet (1 vision call) before individual frames; text before
screenshots; `max_frames` capped at 6–12 by the machine profile. A 20-shot video must never become 20
vision calls by default.

### D6 — No implementation before a baseline commit and annotated tag

Per `~/.dsh/AGENTS.md`. The workspace `$WORKSPACE` is being put under git as part of
this deliverable.

## 6. Risks and limits, stated before they bite

| # | Risk | Handling |
|---|---|---|
| R1 | Nested `ctx.llm.stream()` inside a tool deadlocks or races (§2.6) | probe in Phase 0 before any tool depends on it; fallback = required HTTP endpoint, config-driven, like the prior art |
| R2 | `small int8` too slow / too much RAM on T4 | Phase 0 RTF gate; fall back to `base`, then to cloud with operator approval |
| R3 | Non-speech audio (music, tone, sound events) yields nothing | accepted, documented gap — STT transcribes words only |
| R4 | Frame extraction on a 10-minute video exceeds the tool timeout / RAM | duration caps, frame caps, serial jobs, hard timeout on every subprocess |
| R5 | A plugin runs as **trusted host code** with full filesystem reach | no network except the configured model route; `execFile` argv only (no shell); path safety; temp cleanup in `finally`; artifacts in a declared directory |
| R6 | Installing via `dsh plugin add` is pnpm-inside-the-profile — the known split-Symbol crash vector (**re-confirmed today**: `dsh plugin --help` printed pnpm's own help) | copy-restore into `~/.dsh/profiles/web/node_modules/<name>` + one `cordis.patch.yml` row, per `dsh-plugin-install-safety` |
| R7 | Prompt-injection: on-screen text in a frame can carry instructions | the tool output labels frame text as **data**, never as instructions |
| R8 | The plugin could become a way to fake visual approval | any image-read failure still obeys `image-read-failure-handoff`; the plugin must never synthesise a description it did not get from a real model call |

## 7. Open questions the operator should settle before coding

1. **Audio privacy:** if local STT proves too slow, is sending audio to a cloud ASR acceptable, or is
   "audio stays on the machine" a hard rule?
2. **Scope of "voice":** recordings and voice notes only (this plan), or also live microphone capture
   (a different, client-side product)?
3. **Video source:** local files only, or URLs (adds `yt-dlp` and a terms-of-service question —
   `youtube-link-reader` currently owns YouTube)?
4. **Time box:** the current box is 2 build-days (10 h). The honest estimate in `PLAN.md` is ~15 h.
   Approve an extension now, or cut scope to image + audio?
5. **Publishing:** is this a private enabler, or a portfolio plugin we intend to publish (which would
   add licence, README, screenshot, leak-scan and pre-flight gates)?

---

*Evidence paths are given relative to `dsh/`; every line number was read on 2026-10-30 against DSH
0.1.1-rc.2. Nothing in this document was inferred from a datasheet or a vendor claim.*
