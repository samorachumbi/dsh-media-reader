# The storefront

A single static page that sells the **commercial licence** for `dsh-media-reader` at
**$79 / KSh 10,000 per team, one time**. No build step, no framework, no dependencies: `index.html`
is the whole site apart from two images in `assets/`.

## Why this page exists at all

The plugin crate is public and free for **personal, non-commercial** use — that is the funnel, and it
is deliberate: a buyer should be able to download the artifact, check its hash and run the 18-check
smoke test **before** paying anything. What the free download does not grant is the right to use it in
a commercial product. That is the only thing being sold, and the page says so in one table rather than
hiding it in a licence file.

## Switching checkout on — the only edit needed

`index.html` carries one JSON block near the top, `#pay-config`. A method renders as a real button
**only when it has both a `url` and a `verified` date**:

```json
{ "id": "flutterwave", "label": "Pay by card, M-Pesa or PayPal",
  "url": "https://<your-flutterwave-payment-link>", "verified": "2026-11-04" }
```

- `url` — the hosted-checkout link (Flutterwave payment link, Pesapal payment URL, IntaSend link).
- `verified` — the date **you** saw a real (or test-mode) payment complete through that rail. This
  field exists because a checkout that has never taken money is not a checkout. Leave it blank and the
  button stays off.

While no rail is verified the page renders the price, an explicit "checkout is not open yet" note and
the free download — never a button that looks like checkout and does nothing.

## Which processor, and why

The requirement is one hosted checkout that accepts **M-Pesa, cards and classic PayPal**.

| processor | M-Pesa | cards | classic PayPal | verdict |
|---|---|---|---|---|
| **Flutterwave** | yes | yes | **yes** — documented PayPal partnership for African merchants | the only one of the three that meets the requirement |
| IntaSend | yes | yes | no — **PYUSD only**, PayPal's stablecoin, not card-linked PayPal | does not meet it |
| Pesapal | yes | yes | unverified — no current PayPal claim found | do not build on it |

Sources: [Flutterwave — pay with PayPal](https://flutterwave.com/ng/blog/pay-with-paypal-on-flutterwave),
[TechCabal — PayPal on Flutterwave merchant payments](https://techcabal.com/2021/03/16/paypal-available-on-flutterwave-merchant-payments-africa/),
[IntaSend — accept PayPal via PYUSD](https://www.linkedin.com/posts/intasend_accept-paypal-payments-via-pyusd-want-to-activity-7407679933914902528-schq).

**The decisive test is in the dashboard, not in this file:** create a payment link and look at the
methods the hosted page actually offers. If PayPal is not listed for your account and currency, the
requirement is unmet and the answer is a second button (PayPal direct, once that account is healthy) —
not a claim on the page.

## Deploying

Cloudflare Pages, from this directory. Two ways:

```bash
# one-off, no account setup beyond `wrangler login`
npx wrangler pages deploy . --project-name itikia-store    # run from the repo's store/ directory

# or connect the repo in the dashboard:
#   build command: none    output directory: store
```

`itikia.co.ke` already has working DNS and email on Cloudflare; point the Pages project at it (or a
`store.` subdomain) once the page is worth indexing. **Do not index it before checkout works** — a
store page with no way to buy is worse than no page, and search engines cache that.

## What this page claims, and what it does not

Every number on it is traceable:

| claim | source |
|---|---|
| 18/18 live checks | `ACCEPTANCE.md`, re-run from the extracted tarball against the live profile on 2026-11-03 |
| 97/97 unit tests | `npm test` in the plugin repo |
| 76 files with a sha256 each | `MANIFEST.json` inside the bundle; 0 hash mismatches when re-checked |
| 0 home paths or credentials inside the bundle | the build's own hygiene gate, which fails the build if either appears |

It does **not** claim any customer, any testimonial or any revenue: there are none yet, and inventing
one would be the single fastest way to lose the first real buyer.

## Before this goes live

1. Open the processor account, create a payment link, **confirm PayPal appears in the hosted checkout**.
2. Make one small live payment to yourself and watch the money arrive and the confirmation render.
3. Put the link and that date into `#pay-config`.
4. Decide the refund line — the FAQ currently says "I will either fix it or refund you", which is a
   promise only you can make.
5. Deploy, then re-check the page at 320px on a real phone.
