# Evidence — storefront rendering

Captured 2026-11-03 with a headless Google Chrome 155 driven over CDP (`Emulation.setDeviceMetricsOverride`
with `mobile: false`, so the widths below are **exact CSS pixels**), from the working tree that this file
was committed with. Full-page captures, lazy images forced to load first.

| file | viewport | page height | horizontal overflow | images |
|---|---|---|---|---|
| `page-320.png` | 320 × 900 | 8357 px | none | 2/2 loaded |
| `page-390.png` | 390 × 900 | 7321 px | none | 2/2 loaded |
| `page-768.png` | 768 × 900 | 5457 px | none | 2/2 loaded |
| `page-1440.png` | 1440 × 900 | 4098 px | none | 2/2 loaded |

The PNG's own pixel height equals the page height in this table — checked with `ffprobe`, because an
earlier capture pass wrote 900 px strips while its console cheerfully printed "done". The cause was a
`Page.navigate` followed by a fixed 500 ms sleep: it sometimes measured `about:blank` (exactly viewport
height) before the document committed. The capture now polls until `readyState === "complete"`, an `<h1>`
exists and `scrollHeight > innerHeight`, and **refuses to write a file** whose height is not greater than
the viewport.

Measured from the live DOM at each width, not from the stylesheet:

- **interactive targets under 44 px: 0** at every width (they were 6–10 before the fix: nav links were
  22 px and FAQ summaries 28 px);
- **dead navigation links: 0** — every nav href resolves to a section that exists;
- **checkout buttons rendered: 0** — correct while no payment rail is verified. The buy area renders a
  status note plus two real destinations (the free download and the licence enquiry), never a button that
  cannot take money.

## Defects this evidence pass caught, both now fixed

1. **Horizontal overflow at 320 px and 390 px** — a `<code>` holding
   `/home/<user>/artifacts/videos/…/digest.md` measured **356 px** wide and pushed the document to 412 px.
   Fixed with `overflow-wrap: anywhere` on `code`.
   *The first measurement run missed it because `mobile: true` scales the visual viewport so
   `scrollWidth === innerWidth` even when the page overflows. Measuring in exact CSS pixels found it.*
2. **Side padding silently removed** — `.site-inner` and `footer.site` set `padding: 14px 0` /
   `32px 0 56px`, which **overrides** the `0 16px` that `.wrap` supplies, so the wordmark, nav and footer
   sat flush against the screen edge. Fixed with `padding-block`; re-measured as 16 px at 320 and 176 px
   (centred) at 1440.

## What this evidence does NOT prove

- Nothing about **dark theme**: the page supports `prefers-color-scheme`, and no capture was taken with it
  forced on. Appearance in dark mode is unverified.
- Nothing about a real phone: these are emulated viewports, not a device.
- Nothing about the checkout: it has not been enabled, so the paid path is untested by construction.
- Nothing about contrast ratios: measured colours were not compared against WCAG thresholds.

## Buy-area behaviour, verified both ways

The `#pay-area` is the one part of this page a buyer must be able to act on, so it was checked in both
states and with scripting disabled:

| state | status note | CTA links | blank or `#` hrefs |
|---|---|---|---|
| JavaScript **off** (static markup) | shown | 2, both visible | 0 |
| JavaScript **on**, no rail configured | shown | 2, both visible | 0 |
| JavaScript **on**, one rail configured (local test URL) | hidden | 1 — `Pay by card, M-Pesa or PayPal · $79`, 56 px tall | 0 |

The third row was exercised with a **local test URL** (`checkout.example.test`), not a real processor, to
prove the switch-on branch replaces the fallback instead of stacking on it. It does **not** prove a real
checkout works: no rail has taken a payment yet.

Before the fix, the whole buy area was script-rendered, so with JavaScript off the only calls to action on
a sales page disappeared. The markup now carries the fallback and the script clears the area before
repainting.

## The interactive demo in the hero (added after the images above)

`#demo` is a `<figure>` inside the hero section, following the pattern approved on the Itikia site: a
visible cue ("Pick a file to see what your agent gets"), a provenance line ("Real output · captured from
a live session"), real `<button>`s with `aria-pressed`, and a `role="status"` region that announces the
result. Three files, three tools, each showing the block the plugin actually inserted into the composer
draft on this machine.

Driven with **real mouse events** (`Input.dispatchMouseEvent`) at each button's centre, then the DOM was
read back — a click is not evidence, the changed result is:

| click | tool line | first line of the panel | characters | `aria-pressed` |
|---|---|---|---|---|
| hello.png | `media_image` | `[media: hello.png]` | 593 | exactly one pressed |
| jfk.wav | `media_audio` | `[media: jfk.wav]` | 495 | exactly one pressed |
| error-demo.mp4 | `media_video` | `[media: error-demo.mp4]` | 856 | exactly one pressed |

Button sizes at 1440 and 390 px: 61 px tall (the minimum is 44). No horizontal overflow at either width.
With scripting off the markup already shows the image result, so the demo degrades to a real example
rather than an empty panel.

**What the demo does not prove:** that a dropped file behaves identically on your harness — the text is a
captured record, not a live analysis on the visitor's machine. Paths in the audio and video blocks are
shown as bare file names, and each block is trimmed; the note under the panel says both.

## "Try your own file" — measured on the device, nothing uploaded

The four chips above show captured plugin output. The fifth control lets a visitor measure **their own**
file, in the browser, with no upload and no server.

That split is deliberate. The plugin's reading needs `ffprobe`, `faster-whisper`, a numpy/scipy DSP worker
and the vision route — all on the harness host. A static page cannot run any of it, and uploading a
stranger's media would mean hosting, cost, abuse control and a retention policy. So the browser measures
what a browser can measure, the panel says plainly what it cannot, and that gap is the sales argument: the
plugin adds the *reading*, not the metadata.

Verified against **ffprobe** on the same files, so the browser's numbers are not taken on trust:

| input | path | browser said | ffprobe says |
|---|---|---|---|
| `hello.png` | file picker | `640x360 px`, `8.8 KB (8,979 bytes)` | 640×360, 8979 bytes |
| `jfk.wav` | file picker | `11.00 s` | 11.00 s |
| `error-demo.mp4` | **real drag-drop** | `640x360 px`, `11.00 s` | 640×360, 11.00 s |
| `package.json` | file picker | refused: `not an image, audio or video file` | n/a |

### The race this caught, and the test that now pins it

A capture showed the header reading *"your browser · 0.02 s"* while the panel body still held the plugin's
`hello.png` block. Cause: the demo's initial render used a 700 ms timer, so a visitor who picked their own
file inside that window had the result silently overwritten.

The initial paint is now synchronous and a pending paint is cancelled when a file is picked. The harness
gained a race case (click an example, pick a file 100 ms later, wait 1.2 s, assert the visitor's file is
still shown), and **it was shown to fail on the defect**: with the race reintroduced in a throwaway copy,
the harness died naming the stale content — `drop never showed error-demo.mp4; panel says "[media:
hello.png]"`. All 8 checks pass on the fixed page.

### What this still does not prove

- Nothing is claimed about formats the browser cannot decode (e.g. HEIC, MKV): those take the failure path
  with an honest message, which is *not* the same as the plugin accepting them.
- The client-side measurement is a convenience, not the product: it does not read, describe, transcribe or
  detect anything.

## Self-serve setup wizard

19 assertions, all passing, driven by real mouse clicks and asserted on the generated text:

| scenario | what the page produced |
|---|---|
| DSH + vision + video | `media_video` task, sha256 check, `./smoke.sh` → 18/18, `dsh plugin add` forbidden, model advice names a vision route |
| DSH + text-only + audio | `media_audio`, "no vision model needed" |
| DSH + text-only + evidence pack | `media_evidence`, "a text-only route is fine", no generation call |
| DSH + Node missing | blocked with the prerequisite; copy button and model card hidden |
| non-DSH harness | "installs into DeepSeek Harness only", offers the architecture instead |
| a supplied file path | the first task names that exact file |

A visual read through the plugin's own `media_image` tool confirmed the section heading, all eight field
labels and the Generate button, and caught one truncation — "Analyse video (shots + trans…" in the goal
dropdown — so the option labels were shortened to fit at every width.

**Harness defects found while testing this, and fixed:** the click landed outside the viewport because the
wizard sits below the fold (the harness now scrolls first); the width sweep crashed on `pay-area` being null
because it was navigating to port 8099, a server that had been stopped; and a "wizard" screenshot was
actually the hero because the clip used viewport-relative coordinates after a scroll (now absolute page
coordinates plus `window.scrollY`).
