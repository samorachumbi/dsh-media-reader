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
{ "id": "paddle", "kind": "paddle", "label": "Pay by card, Apple Pay or PayPal",
  "note": "Paddle checkout — cards, Apple Pay, Google Pay and PayPal where available.",
  "priceId": "pri_…", "clientToken": "live_…", "verified": "YYYY-MM-DD" }
{ "id": "paystack", "kind": "link", "label": "Pay by M-Pesa or card (Kenya)",
  "note": "Paystack checkout — M-Pesa, Visa, Mastercard, charged in KES.",
  "url": "https://paystack.com/pay/…", "verified": "YYYY-MM-DD" }
```

There are **two rail shapes**, because Paddle has no website checkout URL:

- **`kind: "link"`** — a hosted checkout URL. Renders an `<a>` when it has `url` **and** `verified`.
- **`kind: "paddle"`** — Paddle's **overlay checkout**, which needs `priceId` **and** a client-side
  `clientToken` (plus `verified`). Renders a `<button>` that lazily loads Paddle.js and opens the overlay.

- `verified` — the date **you** saw a real payment complete through that rail. This field exists because a
  checkout that has never taken money is not a checkout. Leave it blank and the button stays off.

While no rail is verified the page renders the price, an explicit "checkout is not open yet" note and
the free download — never a button that looks like checkout and does nothing.

## Which processor, and why

Research is in the vault: `concepts/payment-rails-kenya-international.md` and the `/paddle-setup` skill.

| rail | why | state |
|---|---|---|
| **Paddle** (merchant of record) | Kenya is not on Paddle's unsupported-seller list; **5% + 50¢**; sole traders accepted; global VAT/GST handled; cards, Apple/Google Pay, PayPal, and China-only Alipay/WeChat Pay | not live |
| **Paystack Kenya** | M-Pesa **1.5%**, local card 2.9%, **international card 3.8%**; USD settlement; no-code Payment Pages | not live |
| 2Checkout | optional third rail: the only documented **UnionPay** path for a Kenyan seller; fees contract-only | not used |
| crypto (CoinPayments) | optional fourth rail, stablecoins only (USDC on Polygon ≈ $0.0023) | not used |

**Paddle is not a no-code paste-a-link processor.** Its docs state hosted checkout is *"for Mac or iOS apps
only"*, so a website integrates **Paddle.js** (`Paddle.Initialize` + `Paddle.Checkout.open({ priceId })`).
That is still serverless — client-side only — but it is code, and the rail reflects it.

**Two things Paddle requires before it will verify the account**, both now present:

1. publicly reachable **Terms** (`terms.html`), **Privacy** (`privacy.html`) and **Refunds** (`refund.html`),
   linked in the site nav — refund window is **14 days**;
2. a **contact email on the homepage** — `hello@itikia.co.ke` (verified by SMTP RCPT: accepted for that
   address, rejected for `info@`, `support@` and a random control, so it is a real routing rule, not a catch-all).

Prices must match the Paddle catalog, which is why the page now says **charged in USD** and marks the shilling
figure as indicative: **KES is not a currency Paddle supports.**

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
| 113/113 unit tests | `npm test` in the plugin repo |
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

## Contact and portfolio

Who is selling, and how to reach them:

- **Itikia Digital Solutions**, Nairobi, Kenya — <hello@itikia.co.ke> (SMTP `RCPT TO` returns
  `250 2.1.0 Ok`, and a `550` for an unknown mailbox, so the route is proven to accept mail).
- Open an issue on the plugin repository: <https://github.com/samorachumbi/dsh-media-reader/issues>

The rest of the workbench this store sits on:

- [dsh-plugin-install-guide](https://github.com/samorachumbi/dsh-plugin-install-guide) — why
  `dsh plugin add` can leave a profile unable to run any tool call, and the install method that cannot
- [dsh-cost-bubble](https://github.com/samorachumbi/dsh-cost-bubble) — live cost of the current chat
- [dsh-app-launcher](https://github.com/samorachumbi/dsh-app-launcher) — plugin pages in their own OS window
- [dsh-daily-progress-tab](https://github.com/samorachumbi/dsh-daily-progress-tab) — the planner tab

## "Try your own file" — and why it stops where it does

The demo's fifth control measures the visitor's own file **in the browser**, with no upload and no server:
name, type, byte size, image dimensions, audio/video duration and video dimensions. Verified against
`ffprobe` on the same fixtures, so the browser's numbers are not taken on trust.

It deliberately stops there, and the panel says so in its own output:

```
<notMeasuredHere>the description, the on-screen text, the transcript, the shots, tempo and key.
Those need ffprobe, faster-whisper and the vision route running on your own harness — that is what the
plugin adds. This page can only show you the container.</notMeasuredHere>
```

### Could a visitor's own file be interpreted live on the page?

Not from a static site, and the reason is the product itself: the reading is done by `ffprobe`,
`faster-whisper`, a numpy/scipy DSP worker and the vision route, all on the harness host. Three options,
honestly costed:

| option | what the visitor gets | what it costs | verdict |
|---|---|---|---|
| **A. browser-local measurement** (built) | their file's real container facts, instantly | nothing — no server, no upload, no data handling | shipped |
| **B. our server runs the real tools** | the actual description / transcript / shots for their file | a container with ffmpeg + faster-whisper (~500 MB image plus a base model), one job at a time, an API key for the vision route, per-IP rate limits, hard caps (≈10 MB image, ≈30 s audio/video), a queue timeout, and a retention policy because someone else's media is now on your disk. Roughly 1–2 build-days plus $5–15/month, and each demo spends a few cents of vision tokens | do it only after the first sales justify it |
| **C. "request a 15-minute live demo"** | a real person analysing their real file | your time only | the cheapest way to serve the visitor who wants B |

The honest recommendation for launch is **A + C**: A is already live and costs nothing, and C converts the
high-intent visitor without a public upload endpoint. B becomes worth building when there is evidence that
visitors abandon because the demo is not *their* file.

**Nothing about A implies B.** The page never suggests the visitor's file is being analysed; the panel
states what was measured, by what, and what was not.

## Self-serve setup: a prompt for the visitor's own agent

The section **"Install it with your own agent — no call, no booking"** replaces the live-demo option. The
visitor answers their harness, runtime, model route and goal; the page generates a prompt for **their** LLM,
on their device, with nothing uploaded.

Why this and not a booking: a booked demo needs a time zone, a language and a stranger's file on your disk.
A generated prompt needs none of those — it is an artifact written for a model, so the language barrier
disappears by construction, and the visitor's own machine does the work and bears the cost.

The prompt is not a tutorial to read. It tells the agent to:

1. download the bundle and **verify its sha256** before trusting it;
2. run `./install.sh --dry-run`, then `./install.sh`, then `./install-skills.sh`;
3. **never** run `dsh plugin add` (the split-Symbol crash), and read the bundle's
   `skills/dsh-plugin-install-safety/SKILL.md` first;
4. restart, or boot a scratch instance per `skills/dsh-test-boot/SKILL.md`;
5. **verify** with `DSH_TEST_URL=… ./smoke.sh` and stop if it is not `18/18 checks passed`;
6. run a first task chosen from the visitor's goal (`media_image` / `media_audio` / `media_video` /
   `media_evidence`), personalised with the file path they supplied.

Model advice is computed from **route × goal**, not from preference: audio and the evidence pack need no
vision model at all; images and video want a vision-capable route, or `visionFallback` pointed at one on a
text-only route. Model names are labelled dated observations and linked to the provider's release note.

**Two honest branches, so the page never hands out a prompt that cannot work:** a non-DeepSeek harness gets
the architecture and an explicit "this bundle does not install here", and `Node < 20` gets the prerequisite
instead of an install prompt. Both hide the copy button.

Verified with real mouse clicks and by reading the generated text: 19 assertions across six scenarios
(vision+video, text-only+audio, text-only+evidence, Node missing, a non-DSH harness, and a supplied file
path personalising the first task).

`llms.txt` sits beside this page for the same reason: it is the machine-readable index an agent can read
before deciding anything.

## Turning checkout on — the operator's runbook

Two rails, done in this order because the second one needs the site live first.

**Paddle (international).** Open the account at <https://vendors.paddle.com/signup> as an
**individual/sole trader** — business verification is skipped for sole traders, identity verification is not.
Create the product with tax category **`standard`** ("pre-written software downloaded and installed onto a
local device"), one price of **79.00 USD**, no billing cycle, quantity 1–1. Submit `store.itikia.co.ke` under
**My account › Settings › Website approval** (manual review 5–7 business days). Add payout details (bank or
Payoneer, monthly, **$100 minimum**). Then create a **100% discount code**, run one real checkout on the
approved domain, confirm the transaction completes, and archive the code. Paste the `priceId` and the
`live_` client token into `#pay-config`.

**Paystack (Kenya).** Open the account (Starter tier if unregistered), create a **Payment Page** for
KSh 10,000, and request international payments **only after the site is deployed** — Paystack asks for a live
page showing where the digital product is sold. Paste the page URL into `#pay-config`.

### The day you deploy — two things, both mandatory

1. **Turn checkout on**: put the live link and its verified date into `#pay-config`.
2. **Link the repo to the storefront.** Write the live URL into `store/DEPLOYED-URL` (one line, nothing else),
   then add it to `README.md` (a client reads that first), this file and `package.json`. The pre-compact audit
   runs `tools/check-storefront-linked.sh` as **stage 9** and **fails the whole audit** until all three mention
   it — so this cannot be quietly left out.

### Fulfilling an order when it lands

```bash
python3 tools/issue-licence.py --buyer "Their Company" --email them@example.com --order <provider reference>
```

Writes `licences/<reference>-<name>.md` — a licence naming the licensee, the order, the date and **the exact
artifact sha256**, and prints the line to paste into the reply. `licences/` is gitignored because those files
carry a buyer's name and address and this repository is public. The script refuses to issue against an artifact
whose `.sha256` does not match its bytes, so a licence can never cover a build that was not the one shipped.

Until a real rail is live, `#pay-config` keeps every method off and the page shows the free path — no button
that cannot take money.
