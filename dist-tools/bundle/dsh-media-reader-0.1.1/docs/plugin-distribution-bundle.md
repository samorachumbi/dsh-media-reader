# Shipping a DSH plugin to another workstation — what the bundle must contain

Learned 2026-11-03 while packaging `dsh-media-reader` for distribution. A plugin tarball that ships only
code fails on the first colleague's machine, because the harness knowledge lives in skills, not in the
package.

## The bundle contract

```
dsh-media-reader-<version>/
  README.md            install-first, readable by a human AND an LLM (no rendering, no images)
  INSTALL.md           the exact steps for both routes, with the failure modes named
  MANIFEST.json        every file with its sha256, plus what is optional
  install.sh           copy-restore; refuses pnpm; runs the duplicate guard; prints next steps
  uninstall.sh         removes the copy and the patch row, leaves the profile otherwise untouched
  plugin/              lib/ python/ package.json cordis.patch.yml README.md
  skills/              product-motion-studio, dsh-plugin-install-safety, dsh-skill-install, dsh-test-boot
  docs/                research, pipeline, acceptance record, direction workflows, pipeline commands
  fixtures/            the small proof files the smoke test needs
  smoke.sh             runs the live capability check against a scratch instance
```

## Why each part is mandatory

| Part | Failure it prevents |
|---|---|
| `skills/dsh-plugin-install-safety` | the colleague runs `dsh plugin add`, pnpm materialises a second `@deepseek-ai/dsh-tools`, and **every** tool call dies with `Cannot read properties of undefined (reading 'prepare')` |
| `skills/dsh-skill-install` | the skills are copied but never linked into `$DSH_HOME/skills`, so no slash command exists and the agent never loads them |
| `skills/dsh-test-boot` | the plugin is installed into the live profile and the server restarted blind; a boot crash costs the operator a session |
| `skills/product-motion-studio` | the plugin gives the model *eyes*; without the production skill it has no method, and produces slop that costs more than the plugin saved |
| `MANIFEST.json` | a partial copy: someone takes `lib/` and forgets `python/`, and STT silently disappears |
| `smoke.sh` | "installed" is not "working" — the check drives real sessions on both the vision and the text-only route |
| `docs/` | the next session cannot re-derive prices, limits, or why a technique was rejected, and pays for the same lesson twice |

## Rules

- **No credentials, no machine paths, no private vault references.** Placeholders in docs, literal values
  only in a git-ignored local file.
- **`README.md` must be readable as plain text** — no badges that carry meaning, no screenshots required to
  install. An LLM reading the tarball must be able to act on it.
- **Install must be reversible in one command**, and `uninstall.sh` must not touch anything it did not create.
- **Verify on a clean profile**, not the one it was developed in: copy into a throwaway `DSH_HOME`, run the
  guards, boot the scratch server, run `smoke.sh`, then tear it down.
