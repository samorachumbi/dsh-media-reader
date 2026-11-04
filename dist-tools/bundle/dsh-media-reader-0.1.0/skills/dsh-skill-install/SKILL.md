---
name: dsh-skill-install
description: Make a skill invocable as a "/name" slash command in the DSH Web composer, and in any DSH profile, by linking it into $DSH_HOME/skills — then verify it actually loads. Use when the user wants a slash command for a skill, when a skill does not show up in the DSH composer, when adding a brand-new skill, or when a skill works in Claude Code but not in DSH.
---

# DSH Skill Install (make a skill slash-invocable)

Turn any `SKILL.md` into a **user-global DSH skill**, so typing `/<name>` in the DSH Web
composer loads it — in every DSH profile (`web`, `headless`, `tui`, …) and every project.

## Why this exists (the one fact that matters)

**DSH reads `$DSH_HOME/skills`, not `~/.claude/skills`.** The vault installs skills into
`~/.claude/skills/`, `~/.kimi-code/skills/`, and project `.claude/skills/` — none of which
`dsh-skill-filesystem` looks at. So a vault skill can be perfectly healthy everywhere else and
simply not exist as far as DSH is concerned. That is the whole bug this skill fixes.

## Where DSH looks

`@deepseek-ai/dsh-skill-filesystem` merges these roots (`includeDefaultRoots` defaults true):

| root | source | notes |
|---|---|---|
| `<projectRoot>/.dsh/skills` | `project-dsh` | nearest project root of the session cwd |
| `<projectRoot>/.agents/skills` | `project-agents` | |
| configured `customSkillDirs` | `custom` | per-profile plugin config |
| **`$DSH_HOME/skills`** (`~/.dsh/skills`) | `user-dsh` | **the global user root — install here** |
| `$DSH_AGENTS_HOME/skills` (`~/.agents/skills`) | `user-agents` | |
| bundled | `bundled` | ships with the harness |

## File format contract

- Layout is either `<root>/<name>/SKILL.md` (**directory bundle**) or `<root>/<name>.md` (**flat**).
  Use the directory bundle: its `resourceBase` resolves to the skill's own folder.
- Frontmatter is **mandatory** and must supply non-empty `name` **and** `description`, or the file
  is silently skipped with `skill file … ignored: frontmatter requires name and description`.
- `name` must match `/^[a-z0-9]+(?:-[a-z0-9]+)*$/` (kebab-case, no underscores, no capitals).
- A root entry that is neither a directory nor a `.md` file is ignored — but a stray `README.md`
  **is** parsed and warns. Keep non-skills out of the root.

## Invocation policy (and the trap that silently kills a skill)

Canonical frontmatter keys are **`disable-model-invocation`** and **`user-invocable`**.

> **Trap:** the camelCase keys `userInvocable`, `modelInvocable`, and `disableModelInvocation`
> **throw at parse time** and the file is **discarded**. A Claude-Code-style `userInvocable: true`
> line silently removes the skill from DSH. Never add it.

Defaults: `modelInvocable: true`, `userInvocable: true`. **So a normal skill needs no invocation
frontmatter at all to be slash-invocable** — just `name` + `description`.

## Procedure

Preferred — the vault installer (idempotent, audits every link, accepts any source dir):

```bash
V=$VAULT
"$V/scripts/install-dsh-skills.sh"                 # default source: the vault skills dir
"$V/scripts/install-dsh-skills.sh" /some/other/dir # any dir of *-SKILL.md or */SKILL.md
```

Inline equivalent, when the script is unavailable:

```bash
SRC=/path/to/skills            # files named <name>-SKILL.md  or  <name>/SKILL.md
ROOT="${DSH_HOME:-$HOME/.dsh}/skills"
mkdir -p "$ROOT"
for f in "$SRC"/*-SKILL.md; do
  [ -e "$f" ] || continue
  name=$(sed -n 's/^name:`:space:`*//p' "$f" | head -1 | tr -d '\r')
  [ -n "$name" ] || { echo "no name in $f" >&2; continue; }
  mkdir -p "$ROOT/$name"
  ln -sfn "$f" "$ROOT/$name/SKILL.md"
  echo "linked $name"
done
```

Always **link, never copy** — the canonical file stays the single source of truth, and editing it
propagates to every target (see `mistake-guardrails-SKILL`).

## Verify — two independent checks

**1. Real registry (authoritative).** Drive the actual skill service; do not eyeball the directory.

```js
const BASE = '$HOME/.nvm/versions/node/v24.20.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'
const { Context } = await import(`${BASE}/cordis/lib/index.js`)
const skill = await import(`${BASE}/dsh-skill/lib/index.js`)
const fsProvider = await import(`${BASE}/dsh-skill-filesystem/lib/index.js`)

const ctx = new Context()
ctx.plugin(skill.default)
ctx.plugin(fsProvider, { dshHome: process.env.HOME + '/.dsh', agentsHome: process.env.HOME + '/.agents' })

// GOTCHA: ctx.skills is undefined until the service registers asynchronously.
for (let i = 0; i < 60 && ctx.skills === undefined; i++) await new Promise(r => setTimeout(r, 100))

const list = await ctx.skills.list({ cwd: process.cwd() })   // bound this with a timeout
const s = list.find(x => x.name === 'my-skill')
console.log(s, skill.isUserInvocable(s))   // isUserInvocable gates the human-facing /slash catalog
```

**2. Live effect.** The running DSH instance re-advertises the catalog on its own — after linking,
the skills show up in an **already-open session**. If a fresh link is missing only in the browser,
that is a tab refresh, not a failure.

## Hot reload: no restart needed

`watch` and `watchFollowSymlinks` both default to **true**, so added/edited skills are picked up
live (observed directly). **Skill installs therefore do not need a server restart**, which means
`dsh-test-boot-SKILL` does **not** apply here — that rule is for plugin and
`cordis.patch.yml` changes that only take effect on restart. Only the browser tab may need a
refresh for the slash menu.

## Vault policy: install to every target

Per the standing rule in `skills/README.md`, a skill is global by default. The full target list
(all symlinks to the one canonical vault file):

```bash
V=$VAULT
install_to() {  # quoted args only — never a space-separated for-list
  local name="$1"; shift
  for t in "$@"; do
    mkdir -p "$t/$name"
    ln -sfn "$V/skills/$name-SKILL.md" "$t/$name/SKILL.md"
  done
}
install_to my-skill \
  "$HOME/.claude/skills" "$HOME/.kimi-code/skills" "${DSH_HOME:-$HOME/.dsh}/skills" \
  $HOME/projects/China-to-Kenya-Import-App/.claude/skills \
  $HOME/projects/digital-front-desk/.claude/skills \
  $HOME/projects/flywheel-control-centre/.claude/skills \
  "$HOME/projects/Marketing/.claude/skills" \
  "$HOME/projects/Quick Cash/.claude/skills" \
  $HOME/credit/credit_payments/.claude/skills
```

Note the quoting: `Marketing` is fine, but **`Quick Cash` has a space** and must be quoted — the
exact mistake logged in `mistake-guardrails-SKILL`.

## The trap that cost a skill its whole life: PRESENT IS NOT PARSEABLE

Every check in `install-dsh-skills.sh` used to be `sed`/`grep` against lines, and the audit reported
`installed: 22 | skipped: 0 | broken: 0 | mismatches: 0` while **`field-request` had never once
loaded**. Its frontmatter had `name:` and `description:` — and was **invalid YAML**, because the
description was a plain scalar containing an unquoted `": "`:

```yaml
description: Guide the operator ... instead of a question: the priority subset first, ...
```

DSH parses frontmatter as YAML. That line is a hard parse error, the file is discarded in silence, and
no line-based check can see it.

**Therefore: always parse the frontmatter, never grep it.** The installer now calls
`scripts/skill_frontmatter_problem.py` on every source and every installed link, and reports
`unloadable: N`.

**Quote any description containing `": "`** — single quotes are safest, and keep it on ONE line so a
line-based reader also gets it whole.

### And a guard that could not fail

The first version of that check resolved its helper as `"$VAULT/scripts/…"` — but `$VAULT` is the
**skills directory**, not the vault root, so the path did not exist. With `2>/dev/null`, the failure
was **swallowed and read as "no problem found"**. Reintroducing the broken frontmatter did not trip
it: it printed `unloadable: 0` on a skill it could never open.

Two rules follow, and they are the same rule twice:

- **Resolve a helper from the script's own directory** (`SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"`), never from a variable that means something else.
- **A checker that cannot RUN must report UNVERIFIED, not clean.** The installer now counts
  `unverified:` separately, so silence is never mistaken for a pass. See `a-guard-that-cannot-fail`
  and `the-check-must-prove-it-ran`.

## Traps

| Symptom | Cause |
|---|---|
| Skill works in Claude Code, absent in DSH | It is only in `~/.claude/skills`; DSH never reads it |
| `skill file … ignored: frontmatter requires name and description` | Missing/empty `name` or `description` |
| Linked, resolving, both keys present — **and not in the registry** | Frontmatter is **invalid YAML** (an unquoted `": "` in `description` is the usual cause). `sed` finds the keys; the parser rejects the block. Real case: `field-request`, never loaded. |
| `ignored: invalid skill name` | Not kebab-case (underscores, capitals, leading digit) |
| `ignored: invalid invocation frontmatter` | Legacy camelCase key — use `user-invocable` |
| `ignored: missing YAML frontmatter` | No `---` block on line 1 (a stray `README.md` in the root) |
| In the model catalog but not in the slash menu | `user-invocable: false` is set |
| Link points at nothing | Canonical file moved/renamed; re-run the installer and read its audit |

## Related

- `dsh-global-skill-root` — the verified facts behind every claim here
- `mistake-guardrails-SKILL` — symlink-to-canonical and quoting rules
