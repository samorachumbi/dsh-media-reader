# Path placeholders in this bundle

Absolute paths from the machine that built this bundle were replaced so it works anywhere:

| Placeholder | Meaning |
|---|---|
| `$HOME` | the installing user's home directory |
| `$VAULT` | the builder's private notes vault; background reading only, the bundle does not need it |
| `$WORKSPACE` | wherever this bundle was extracted |
| `$REVIEW_DIR` | the builder's review folder for generated media; any folder works |

Placeholders that appear in this build: $HOME, $VAULT, $WORKSPACE, $REVIEW_DIR

Rewritten files: docs/ACCEPTANCE.md, docs/README.md, docs/RESEARCH.md, docs/image-read-failure-handoff.md, plugin/README.md, skills/dsh-skill-install/SKILL.md
