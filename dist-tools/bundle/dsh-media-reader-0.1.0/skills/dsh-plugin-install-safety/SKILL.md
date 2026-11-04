---
name: dsh-plugin-install-safety
description: Prevent and diagnose the DSH crash "Cannot read properties of undefined (reading 'prepare')" — a split-Symbol failure caused by duplicate @deepseek-ai/dsh-* packages after plugin installs. Use before/after any `dsh plugin` install and whenever a DSH tool call (web_search, browse, etc.) fails with that error or returns no results.
---

# DSH Plugin Install Safety (split-Symbol crash)

## When this applies

- Installing, updating, or removing any DSH plugin (`dsh plugin add/remove`).
- Any DSH session where tool calls die with
  `Cannot read properties of undefined (reading 'prepare')` — or `web_search`
  suddenly returns "no results" after a plugin install.

## The failure (why it crashes)

DSH tool dispatch looks up the scheduler by a **module-level `Symbol`**:

```js
// @deepseek-ai/dsh-agent-loop/lib/index.js:193
const prepared = await ctx.tools[TOOL_RUNTIME_SCHEDULER].prepare(call.exec);
```

`TOOL_RUNTIME_SCHEDULER = Symbol("@deepseek-ai/dsh-tools.scheduler")` lives in
`@deepseek-ai/dsh-tools`. If that package is loaded from **two physical copies**,
the two `Symbol` instances are not `===`, the lookup returns `undefined`, and
`undefined.prepare(...)` throws on **every** tool call.

Two copies appear when pnpm runs inside a profile directory: the profile uses
`nodeLinker: hoisted` and plugins declare `@deepseek-ai/*` peerDependencies, so
pnpm materializes real `@deepseek-ai/dsh-*` directories next to the symlinks.

## Before installing

2. Pin a version compatible with the local DSH
   (e.g. local DSH 0.1.1-rc.2 → plugin `@latest`).
3. **Do NOT put pnpm on PATH for this work.** It is absent from the default PATH, and that absence is
   what makes the crash below unreachable by accident.

# ~/.dsh/profiles/web/cordis.patch.yml  (append)
- insert:
    - id: <id>
      name: '<pkg-name>'
```

Bare `@deepseek-ai/*` imports then resolve through `~/.dsh/profiles/node_modules/` — the shared tree
of symlinks into the ONE global copy — so no dependency needs installing at all.

## After every install — verify no duplicate

```bash
find ~/.dsh/profiles -type d -path '*/node_modules/@deepseek-ai/*'
```

- **Empty output = healthy** — the profile's `@deepseek-ai/*` entries are symlinks
  to the single global copy.
- **Any output = a materialized duplicate** — the next tool call will split the
  Symbol and crash.

## If a duplicate appears (or the crash already happened)

1. Remove the materialized copy so resolution falls back to the single global copy:
   ```bash
   rm -rf ~/.dsh/profiles/<profile>/node_modules/@deepseek-ai/<pkg>
   # or the whole scope dir if unsure:
   rm -rf ~/.dsh/profiles/<profile>/node_modules/@deepseek-ai
   ```
2. Restart the server: `dsh web`.
3. Re-run the `find` above until it prints nothing.

## Diagnosing the crash

- Symptom: `TypeError: Cannot read properties of undefined (reading 'prepare')`
  on a tool call; `web_search` may just return "no results" instead of erroring.
- Confirm exactly one physical copy on disk:
  ```bash
  find ~/.dsh ~/.nvm/versions/node/*/lib/node_modules -type d -name dsh-tools \
    | xargs realpath | sort -u
  ```
  **Group the result by node installation before reading it.** This check counts copies across
  *node versions*, and a duplicate there is **not** a split Symbol. What splits a process's Symbol
  is two copies inside **one process's resolution path**. Corrected 2026-10-02, after this check
  printed two paths (`v22.23.2`, `v24.20.0`) on a perfectly healthy machine. Ask the decisive
  question instead:

  ```bash
  # where do bare @deepseek-ai/* imports actually resolve from a plugin?
  ls -l ~/.dsh/profiles/node_modules/@deepseek-ai/ | awk '{print $11}' | sort -u
  node -e 'console.log(require.resolve("@deepseek-ai/dsh-tools",{paths:[process.env.HOME+"/.dsh/profiles/web/node_modules"]}))'
  ```

  Every line must land in **one** node installation — the one `/usr/local/bin/dsh` runs. On
  2026-10-02 they all pointed at `v24.20.0` while the `v22.23.2` tree was an unreachable leftover
  of an older node. Guard 3 (duplicates under `profiles/*/node_modules/@deepseek-ai/`) was empty,
  and **that** is the real vector. The blunt "must print one path" reading would have aborted a
  correct install.

## Verified against source (DSH 0.1.1-rc.2)

- `@deepseek-ai/dsh-tools/lib/index.js:2416` — `const TOOL_RUNTIME_SCHEDULER = Symbol("@deepseek-ai/dsh-tools.scheduler")`
- `@deepseek-ai/dsh-tools/lib/index.js:2564` — `ToolRuntime[TOOL_RUNTIME_SCHEDULER] = { prepare, dispatch, finalize, finish }`
- `@deepseek-ai/dsh-agent-loop/lib/index.js:193` — `ctx.tools[TOOL_RUNTIME_SCHEDULER].prepare(call.exec)`

Subtle variant to watch for: `dsh-tools` ships a **dual build** — main
`lib/index.js` and subpath `lib/types/*.js` each define their own Symbol. A plugin
importing `@deepseek-ai/dsh-tools/types` (or `./presentation`) directly while the
core uses the main entry also splits the Symbol, even with no duplicate on disk.

## Related
