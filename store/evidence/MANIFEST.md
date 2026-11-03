# Evidence — storefront rendering

Captured 2026-11-03 with a headless Google Chrome 155 driven over CDP (`Emulation.setDeviceMetricsOverride`
with `mobile: false`, so the widths below are **exact CSS pixels**), from the working tree that this file
was committed with. Full-page captures, lazy images forced to load first.

| file | viewport | page height | horizontal overflow | images |
|---|---|---|---|---|
| `page-320.png` | 320 × 900 | 5841 px | none | 2/2 loaded |
| `page-390.png` | 390 × 900 | 5064 px | none | 2/2 loaded |
| `page-768.png` | 768 × 900 | 3969 px | none | 2/2 loaded |
| `page-1440.png` | 1440 × 900 | 2901 px | none | 2/2 loaded |

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
