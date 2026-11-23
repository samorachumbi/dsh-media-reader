# Live machine-readable surface — AFTER L4 deployed the L2/L3 work

Measured 2026-11-23T04:24:50+03:00.

| | |
|---|---|
| Deployment | `10cdc93d-2f88-4485-b964-912ecb33ae0f` (Production, branch `main`) |
| Source commit | `1fe9366` — identical to `origin/main`, tree clean before deploy |
| URL | https://10cdc93d.itikia-store.pages.dev · https://store.itikia.co.ke |
| Payload | 14 files; every published file byte-identical to source on BOTH hostnames |

## Verifier — 10 of 10 checks pass, exit 0

```
verifying the machine-readable surface of https://store.itikia.co.ke

== https://store.itikia.co.ke
  PASS  the live #pay-config parses and declares the commercial terms
        usd 79 · cny 560 · 12 months of updates · 14-day refund · merchant of record Paddle
  PASS  / is served with parseable JSON-LD and exactly one absolute canonical
        https://store.itikia.co.ke/ · 1 JSON-LD block(s)
  PASS  /pricing is served with parseable JSON-LD and exactly one absolute canonical
        https://store.itikia.co.ke/pricing · 1 JSON-LD block(s)
  PASS  /privacy is served with parseable JSON-LD and exactly one absolute canonical
        https://store.itikia.co.ke/privacy · 0 JSON-LD block(s)
  PASS  /terms is served with parseable JSON-LD and exactly one absolute canonical
        https://store.itikia.co.ke/terms · 0 JSON-LD block(s)
  PASS  /refund is served with parseable JSON-LD and exactly one absolute canonical
        https://store.itikia.co.ke/refund · 0 JSON-LD block(s)
  PASS  the live Product offers agree with the live #pay-config price
        USD 79.00 · CNY 560.00 · 14-day window, each agreeing with the live #pay-config
  PASS  the live llms.txt states the same facts as the live page
        ¥560 · 12 months · 14 days · Paddle — all agree
  PASS  the served robots.txt is OURS, not the Cloudflare edge file
        984 bytes with User-agent: * and Allow: / — our file is being served
  PASS  an unknown path returns a real 404 that declares no canonical
        unknown path → 404, no canonical

all checks passed, 0 skipped
```

## The robots.txt question, answered

A Cloudflare zone-level edge file served **1,248 bytes, every content line a comment, zero rules** before this
deploy. After it, `https://store.itikia.co.ke/robots.txt` serves **984 bytes** with:

```
User-agent: *
Allow: /
```

So a Pages deployment **does** replace the edge file at the custom domain. This could not be answered from a
`*.pages.dev` preview — only from the zone — which is why it was deferred to this gate rather than assumed.

## Before and after, measured not asserted

| Surface | Before L4 | After L4 |
|---|---|---|
| `rel=canonical` | 0 of 5 pages | 5 of 5, each absolute and self-referential |
| JSON-LD | none | `Organization` on `/`, `Product` + 2 `Offer`s on `/pricing` |
| Offers | none | USD 79.00 and CNY 560.00, both InStock, no KES offer |
| Refund window | prose only | `merchantReturnDays: 14`, agreeing with `#pay-config` |
| `llms.txt` | no CNY, no updates, no refund, no merchant of record | all present, dated 2026-11-22 |
| `robots.txt` | Cloudflare edge file, 1,248 B, zero rules | ours, 984 B, `User-agent: *` + `Allow: /` |
| 404 | correct already | correct, and still declares no canonical |

## What this does NOT prove

- Nothing about how a *specific* crawler or agent behaves; only what it is served.
- Nothing about the checkout: this gate covers robots, facts and Product/Offer data only.
- Nothing about caching: both hostnames were fetched fresh, but a third-party cache in front of either was not.
