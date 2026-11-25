---
name: document-and-display-reading
description: Read the files and screens an agent normally cannot — PDFs, Markdown, CSV/JSON/YAML, HTML and other documents through media_document, and what a browser- or display-based verification actually proves. Use whenever a file cannot be attached to the composer, when a screenshot or highlight claim is being made, when a page must be verified rather than described, or when a "the feature is missing" report needs a layer-by-layer audit.
---

# Reading documents and displays

Two capabilities, one failure mode in common: an agent that cannot read the input confidently invents what it
says. Everything here exists to make the difference between *read* and *guessed* visible.

## 1. Documents — files the composer refuses

The DSH composer accepts **exactly four image MIME types** — `image/png`, `image/jpeg`, `image/webp`,
`image/gif` — and answers anything else with:

```
Only PNG, JPG, WebP, and GIF images are supported
```

That is upstream behaviour, not a bug in this plugin, and it is why a PDF invoice, a signed licence, a CSV
export or a Markdown spec cannot reach an agent through the UI at all. `dsh-media-reader` ≥ 0.1.3 closes the
gap at the file level:

- the **client half** claims document drops outright (`preventDefault` **and** `stopPropagation`) so the
  composer never answers with that message, and the picker's `accept` lists the document extensions;
- the **host half** routes them to `media_document`, which returns a tagged block, not a guess.

| Extension | What comes back |
|---|---|
| `.pdf` | the text layer via `pdftotext -layout`, plus `<pages>` from `pdfinfo` |
| `.md .markdown .txt .log .rst` | the text, with its real `<extractedChars>` |
| `.csv .tsv` | the text plus `<rows>` and `<columns>` |
| `.json .jsonl` | the text plus `<json>object|array|unparseable</json>` |
| `.yaml .yml .html .xml .srt .vtt` | the text; HTML/XML is reduced to readable text and marked `<derivedFrom>` |

**The two honest edges — never paper over them:**

1. **A scanned PDF returns `document-unreadable` with `<reason>no-text-layer</reason>`.** `pdftotext` exits 0
   with empty output for an image-only PDF; returning `""` would read as "empty file" and the model would
   summarise nothing with total confidence. The guidance names the working route: render the pages
   (`pdftoppm -r 200 -png file.pdf /tmp/page`) and call `media_image` on the PNGs — real image blocks on a
   vision route, a described frame on a text-only route.
2. **Truncation is stated**: `<truncated>true</truncated>` plus a note naming the cut, so a long document is
   read in sections rather than mistaken for complete.

A missing extractor is reported as `MISSING_TOOL` with the install hint (`sudo apt install poppler-utils`),
never as an empty document. Binary bytes with a text extension return `<reason>binary-content</reason>`.

## 2. Displays and browsers — say which layer you proved

Four separate claims, routinely confused:

| Claim | What actually proves it |
|---|---|
| the page **rendered** | CDP `Page.captureScreenshot`, or `--eval` reading the DOM |
| the app **handled** an event | a synthetic event reaching your handler (proves the handler, nothing more) |
| the OS **delivered** an event | a real drag/paste from a real app, or the operator's eyes |
| a human **saw** it | the operator's sentence, dated — or a compositor screenshot |

`scripts/capture.mjs` (in the media-reader repo) is the browser side:

```bash
node scripts/capture.mjs --url <url> --out /tmp/cap [--width] [--height] [--theme dark] [--reduced] \
  [--shots 0,1000,4000] [--full] [--scroll px] [--selector css] [--rects 'a,b'] \
  [--eval '<js>'] [--click 'css@ms'] [--headful]
```

- `--eval` records DOM/computed state **per frame**. A PNG cannot distinguish *paused* from *finished*.
- `--click '<css>@<ms>'` reaches states a still frame cannot: a paused animation, an opened panel.
- Every frame records `atMs` (nominal) **and** `actualMs` (measured); screenshots cost ~0.5 s each, so a
  nominal timeline drifts — anchor an animation capture by restarting it at frame 0.
- `--headful` needs the session's compositor.

## 3. Traps that have already cost this machine hours

| Symptom | Cause | Fix |
|---|---|---|
| `Chrome never wrote DevToolsActivePort — it did not start` | Wayland desktop, Chrome tried X11 | `--ozone-platform=wayland` (capture.mjs sets it for `--headful`) |
| `Authorization required, but no authorization protocol specified` | X sockets exist, this shell is not authorised | use CDP, or the operator's session |
| `compositor doesn't support wlr-screencopy-unstable-v1` | `grim` is wlr-only; GNOME's Mutter implements none of it | never install grim for GNOME — use `xdg-desktop-portal` Screenshot (async request handle) |
| `Access denied` from `org.gnome.Shell.Screenshot` | GNOME reserves it for the shell | portal, or the operator |
| `hidden` element still visible | an author `display` rule beats the attribute | add `[hidden] { display: none }` beside every rule that sets `display` |
| "the feature is missing" | you inspected the landing page, not the state the user is in | re-check inside a session, with real data |
| two identical frames read as "it stalled" | the run had already finished | read the state (`--eval`), not the pixels |

## 4. Working method

1. Identify the **layer** the failure belongs to before changing code: OS, browser, harness, or plugin.
2. Prove the smallest thing that separates two hypotheses, and say which claim each test supports.
3. When a capability is genuinely absent, write it down as a capability gap with the exact error — that is a
   product idea, not a wall — and continue with what is achievable.
4. Never let machine evidence stand in for human eyes, or the reverse.
