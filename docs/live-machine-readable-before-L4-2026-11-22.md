# Live machine-readable surface — BEFORE L4 deploys the L2/L3 work

Measured 2026-11-23T01:06:04+03:00 against https://store.itikia.co.ke by
`node scripts/verify-live-machine-readable.mjs` (exit 1, 9 of 10 checks failed).

This is the BEFORE half of L4's before/after proof. Nothing here is a claim about the source tree:
the source passes its own guards; this is what a reader actually receives today.

```
verifying the machine-readable surface of https://store.itikia.co.ke

== https://store.itikia.co.ke
  FAIL  the live #pay-config parses and declares the commercial terms
        /: #pay-config has no terms block, so the live facts have no single source
  FAIL  / is served with parseable JSON-LD and exactly one absolute canonical
        /: expected exactly one canonical, the served page has 0
  FAIL  /pricing is served with parseable JSON-LD and exactly one absolute canonical
        /pricing: expected exactly one canonical, the served page has 0
  FAIL  /privacy is served with parseable JSON-LD and exactly one absolute canonical
        /privacy: expected exactly one canonical, the served page has 0
  FAIL  /terms is served with parseable JSON-LD and exactly one absolute canonical
        /terms: expected exactly one canonical, the served page has 0
  FAIL  /refund is served with parseable JSON-LD and exactly one absolute canonical
        /refund: expected exactly one canonical, the served page has 0
  FAIL  the live Product offers agree with the live #pay-config price
        /pricing: no Product — the structured price claim is missing from the live site
  FAIL  the live llms.txt states the same facts as the live page
        /llms.txt: no CNY price
  FAIL  the served robots.txt is OURS, not the Cloudflare edge file
        /robots.txt: no "User-agent: *" rule. This is Cloudflare's comment-only edge file, so our deployed robots.txt did NOT replace it (1248 bytes, every content line a comment)
  PASS  an unknown path returns a real 404 that declares no canonical
        unknown path → 404, no canonical

9 check(s) FAILED, 0 skipped
```

## What it establishes

- Live serves **no** `rel=canonical` on any of the five crawlable pages (0 of 5), no `Product`, and a
  `#pay-config` with no terms block — i.e. live is the pre-L2 storefront.
- Live `llms.txt` carries **no CNY price**, so it is the pre-L2 file.
- Live `robots.txt` is **Cloudflare's edge file** — 1248 bytes, every content line a comment, zero rules. Our
  `store/robots.txt` does not reach the site today, and until this phase it was not even on the deploy
  whitelist, so a deploy would not have shipped it.
- The 404 path already behaves correctly (404 status, no canonical).

L4 re-runs the same command after deploying and records the AFTER output beside this file.
