---
type: concept
date: 2026-10-30
tags: [rule, protocol, vision, images, verification, agents, global, mandatory]
---

# An unreadable image is a stop, not a guess

**The rule, in one sentence:**

> **Any future image-read failure must use the mandatory vision handoff rather than proceeding.**

This note is the durable home of that rule. It is installed machine-globally in `~/.dsh/AGENTS.md`
(DSH) and `~/.claude/CLAUDE.md` (Claude Code), and as the invocable skill
[[image-read-handoff-SKILL]] (`/image-read-handoff`). If you are reading this because the rule already
fired, skip to **The handoff**.

## Finding

On this machine an image-reading tool can fail like this:

```
model "kimi-k3.1-pro" does not declare image input; switch to an image-capable model
```

It was hit repeatedly during the Itikia Section 1 build on 2026-10-29, on a task whose whole progress
depended on looking at screenshots. Two properties made it dangerous rather than merely annoying:

1. **It is intermittent.** Retrying sometimes worked. An intermittent failure trains you to retry, and
   after enough retries the next move is to *proceed anyway*.
2. **The substitute is available and plausible.** Everything needed to describe an image is also
   present as DOM, CSS, computed styles and measured pixel boxes. So an agent that cannot see the
   picture can still produce a confident, detailed, wrong description of it.

That is the actual failure: not "the tool errored" but "the tool errored and the work continued with
invented eyes". A visual approval granted that way is fabricated evidence, and it is indistinguishable
in the transcript from a real one.

## Why retrying is not the fix

A retry that happens to succeed does not make the failure impossible; it makes it invisible. The rule
therefore does not say "retry first". It says the *failure* is the trigger, and the trigger's response
is fixed regardless of whether a retry would have worked.

## Trigger

Any of these, from any image-reading path (a vision tool, an attachment read, a screenshot tool whose
reply says it could not interpret the file):

- the current model cannot accept images, or
- the model does not declare image input, or
- the file cannot be read / decoded, or
- an equivalent unsupported-image error.

"Equivalent" includes a silent empty or refusal-shaped reply. An error you cannot quote is still an
error.

## What counts as "proceeding" (all forbidden)

- Claiming the image was inspected, or describing its contents.
- Inferring visual details from DOM, CSS, computed styles, measurements or the code that produced it
  **and presenting them as what the image shows**. (Reading the DOM is fine. Calling it a screenshot
  reading is not.)
- Continuing implementation that depends on what the image would have shown.
- Granting, or accepting on someone's behalf, a **visual approval**.
- Recording a PASS in a checklist whose evidence was that image.

## The handoff

Stop the work and produce this for a vision-capable LLM. Every field, or say why it cannot be filled.

```
BLOCKED
  Exact tool error, quoted verbatim. If several, all of them, in order.

OBJECT
  Absolute paths of every image, one per line.
  Page URL, commit hash and tag, and the viewport (width x height) for each image.
  Theme (light/dark) and any device-pixel-ratio scaling.

STATE
  What the page was doing when captured: interaction step, elapsed time, animation frame.
  Whether the cue/overlay was in its initial, peak, resolved or paused state.
  Whether reduced motion was on.

NEED  (the precise visual questions - never "does it look OK?")
  Wrapping: does any label wrap, and where does it break?
  Collision: does any element overlap or sit within Npx of another?
  Clipping: is any glyph or label cut off at the container edge?
  Contrast: is this specific text legible on this specific ground?
  Cue visibility: is the attention cue visible in THIS frame, and on which element?
  Selected-state distinction: can the selected item be told apart from the cued one?
  Spacing: are the stated gaps actually present?

ANIMATION EVIDENCE
  Frames at 0s, 1s, 2s, 4s and 8s - not one frame dressed up as "the animation".
  Plus one paused frame and one reduced-motion frame.

ACCEPTANCE CRITERIA
  Measurable PASS/FAIL per item. "Looks good" is not a criterion.

REQUIRED REPLY
  PASS/FAIL per item, the specific defect for each FAIL, and one explicit line:
  "implementation may resume" / "implementation must not resume".
```

## Operator-designated scratch route (added 2026-11-01)

The operator has designated the scratch DSH vision service at `http://127.0.0.1:3096/` as the preferred
handoff destination when the current model cannot read an image. If it is live, send the complete handoff
and timestamped evidence through a dedicated session on an explicitly image-capable model (currently
`deepseek-v4-flash-vision-exp`), then wait for the per-item verdict and explicit resume/no-resume line.
This changes the **destination**, never the stop rule: it is not a retry, not a substitute visual approval
from the parent model, and not permission to keep implementing. If scratch is unavailable or cannot read
the evidence, stop and ask the operator.

## While the handoff is out

- Do not implement.
- Do not mark the task done, verified, clean or approved.
- Tell the operator the work is blocked and what is missing. A blocked task is an acceptable state; a
  fabricated reading is not.
- Record the handoff and its returned verdict in the journal **before** resuming, so the next session
  inherits the verdict rather than re-deriving it.

## If no vision-capable LLM is available

Stop and ask the operator. Offer the two honest options: the operator looks and answers the NEED
questions, or the work waits. Never downgrade to inference because the other path is unavailable.

## How to check the rule is actually installed

The rule is only a guard if it is reachable from every entry point. Verify by grep, not by memory:

```bash
grep -l "must use the mandatory vision handoff rather than proceeding" \
  ~/.dsh/AGENTS.md ~/.claude/CLAUDE.md \
  $VAULT/INDEX.md \
  $VAULT/concepts/image-read-failure-handoff.md \
  $VAULT/skills/image-read-handoff-SKILL.md
ls -l ~/.dsh/skills/image-read-handoff/SKILL.md   # must resolve
```

Five files, one resolving symlink. Four files means an entry point lost the rule.

## Standing caution

This is a **manual** control, held in place by instruction files and a skill. There is no code that
detects an unsupported-image error and refuses to continue. Until a tool or plugin enforces it
mechanically, the enforcement is the agent reading this and obeying it — which is exactly why it is
installed in global instruction files rather than a project README.

## Related

- [[image-read-handoff-SKILL]] — the invocable version (`/image-read-handoff`)
- [[task-exit-gate-SKILL]] — the gate that requires a "what was not verified" line, which is where a
  blocked visual check must be declared
- [[interactive-selector-affordance]] — the Itikia Section 1 work this rule was hardened on
- [[a-200-is-not-a-working-feature]] — same shape: a proxy signal is not the thing itself
- [[evidence-review-SKILL]] — grades findings by evidence strength; an invented reading would be
  "unconfirmed" at best and must never be reported as "verified"
