# Machine-readable fact audit — L1

**Date:** 2026-11-22 · **Phase:** L1 of the discovery-repair plan §"L1 — Machine-readable fact audit"
**Scope:** inventory only. **No implementation.** L2 builds; L1 records what is true today and what each fact must
become.

The plan asks for a *written field map: fact → source → required URL representation*. That is below, after the
inventory, because the inventory is what exposes the gaps the map has to close.

---

## 1. Inventory — what exists today

### Plain-text agent surfaces

| Surface | State | Detail |
|---|---|---|
| `store/llms.txt` | **exists**, 1,820 B, dated `2026-11-19` | Tagged storefront link (`utm_source=llms`), pricing/refund/terms/licence links, five-skill list, install and verification facts |
| `store/robots.txt` | **absent from the repo** | **The live URL returns 200 anyway** — 622 B of Cloudflare "content signals" injected at the edge, with **no `Sitemap:` line**. We do not control it |
| `store/sitemap.xml` | **absent** | live `/sitemap.xml` → **404** |
| `store/humans.txt` | absent | not required by the plan |

### Per-page metadata

| Page | `<title>` | `meta description` | `rel=canonical` | Open Graph | Twitter card | JSON-LD |
|---|---|---|---|---|---|---|
| `index.html` | yes | yes | **none** | **0** | **0** | **0** |
| `pricing.html` | yes | yes | **none** | **0** | **0** | **0** |
| `privacy.html` | yes | yes | **none** | **0** | **0** | **0** |
| `refund.html` | yes | yes | **none** | **0** | **0** | **0** |
| `terms.html` | yes | yes | **none** | **0** | **0** | **0** |
| `404.html` | yes | **none** | **none** | **0** | **0** | **0** |

Titles are unique and descriptive on all six pages. **Every page lacks a canonical URL, an Open Graph block, a
Twitter card and JSON-LD.** That is the whole machine-readable gap in one line: the storefront is readable to a
browser and to a plain-text fetcher, and opaque to anything that wants structured data.

### The declared price source of truth

`#pay-config` in `index.html`:

```json
{ "price": { "usd": 79, "kes": 10000, "kesIndicative": true,
             "chargedIn": "USD", "unit": "per team, one-time" } }
```

Rails: `paddle` (kind `paddle`, `verified: "2026-11-16"`, price `pri_01m75znzdsm2gty7vs8hv53nbp`);
`paystack` (kind `link`, `verified: ""` — correctly renders nothing).

### Where each canonical fact is actually stated

| Fact | Surfaces carrying it | Missing from |
|---|---|---|
| USD **79** | `#pay-config`, index, pricing, llms.txt, README, 404 | — |
| **KSh 10,000** (indicative) | index, pricing, llms.txt, README | `#pay-config` (as a separate fact it is `price.kes`) |
| **CNY ¥560** | **pricing.html only** | **`#pay-config`**, index, **llms.txt** |
| **per team, one time** | `#pay-config` (`unit`), index, pricing, llms.txt | — |
| **12 months of updates** | index, pricing, README | **llms.txt** |
| **14-day refund** | index, pricing, refund, terms, 404 | **llms.txt** |
| **merchant of record** | index, pricing, privacy, refund, terms | **llms.txt** |
| **licence terms** | `LICENSE` + terms.html + llms.txt (link only) | — |
| **contact** | **two addresses**: `hello@itikia.co.ke` (41 occurrences, all policy pages) and `samora@itikia.co.ke` (index checker copy + the Worker's licence document) | a single stated canonical contact |

---

## 2. Gaps this audit found

1. **`#pay-config` is not a complete source of truth.** The plan names CNY ¥560 as a canonical fact; it exists only
   as prose in `pricing.html`. The declared source of truth cannot be the thing that produces the page if the page
   knows a fact the config does not. → L2 must add CNY to `#pay-config` (or name Paddle's catalogue as the source and
   derive the page from it).
2. **`llms.txt` — the one file written for machines — omits four canonical facts:** CNY price, 12 months of updates,
   the 14-day refund, and the merchant of record. It links to the pages that state them, which is better than
   nothing, but an agent asking "what does this cost and what if I want a refund" cannot answer from the file
   without a second fetch.
3. **No canonical URLs on any page.** Six pages, six missing `<link rel="canonical">`. Every fact therefore has no
   declared URL representation — which is precisely the column the plan asks for.
4. **No JSON-LD anywhere**, so there is no `Product`/`Offer` for the price, no `Organization` for the seller, and no
   machine-readable link between the storefront and the licence terms.
5. **`robots.txt` is edge-owned and unknown.** Cloudflare serves its own 622-byte content-signals file; ours does not
   exist. Whether a deployed `store/robots.txt` would *win* at the edge is **unverified** — the same shape as B3,
   where the edge served something the repository did not contain.
6. **`sitemap.xml` does not exist** (live 404), so the plan's conditional "sitemap link only if a real sitemap is
   published" is not yet satisfiable — and a `Sitemap:` line in robots.txt must wait for it.
7. **Two contact addresses with no declared canonical.** `hello@` is the published support address on every policy
   page; `samora@` appears in the index page's checker copy and in the issued licence document. A machine reading
   both cannot tell which is the contact for what.
8. **`404.html` has no meta description** — minor, but it is a page that can be fetched and indexed.

---

## 3. The field map

`required URL representation` means: the URL that must carry the fact in machine-readable form after L2.

| # | Fact | Source of truth | Required URL representation | Today |
|---|---|---|---|---|
| 1 | Price, USD 79, per team, one-time | `#pay-config` `price.usd` + `unit`; corroborated by Paddle price `pri_01m75znzdsm2gty7vs8hv53nbp` (7900 USD) | `/pricing` as `Product`/`Offer` JSON-LD (`price`, `priceCurrency: USD`, `eligibleQuantity` or description naming "per team, one-time") | prose only |
| 2 | Price, CNY ¥560 | Paddle price `pri_01m76221de66ctw8ep7gzz9zj5` (56000 CNY) — **not in `#pay-config`** | `/pricing` as a second `Offer` with `priceCurrency: CNY` | prose only |
| 3 | Indicative KSh 10,000 | `#pay-config` `price.kes` with `kesIndicative: true` | **must not become an `Offer`** — it is not a chargeable currency. State it as indicative text only | correct today, must stay that way |
| 4 | "per team, one-time" | `#pay-config` `price.unit` | `/pricing` Offer description or `UnitPriceSpecification` | prose only |
| 5 | 12 months of updates | `pricing.html`, `index.html`, `README.md`, and the issued licence text | `/pricing` and `/terms`; a machine-readable statement on `/facts` | absent from `llms.txt` |
| 6 | 14-day refund | `refund.html` (policy of record) | `/refund` with `MerchantReturnPolicy` JSON-LD | policy page exists, no structured data |
| 7 | Licence grant and limits | `LICENSE` in the repo + `terms.html` | `/terms` linking `LICENSE`; `license` field in `Product` JSON-LD | links exist, no `license` field |
| 8 | Merchant of record: Paddle | stated on five pages | `/terms` and `/refund` as `Organization` or a named field, plus `/facts` | prose only |
| 9 | Contact | **undecided** — `hello@itikia.co.ke` vs `samora@itikia.co.ke` | one canonical address on `/` and `/terms`, and in `llms.txt`; `Organization.email` in JSON-LD | two addresses, no declaration |
| 10 | Seller identity | `Itikia Digital Solutions, Nairobi, Kenya` (policy pages, licence) | `Organization` JSON-LD on `/` with `legalName`, `address`, `url` | prose only |
| 11 | Crawlability | `robots.txt` — currently Cloudflare's, not ours | a deployed `robots.txt` referencing a real `sitemap.xml` | **unknown which wins at the edge** |
| 12 | Page set and canonical URLs | the six pages that exist | `rel=canonical` on all six + `sitemap.xml` listing them | none |

---

## 4. Decisions L2 must take, not assume

1. **Which price source wins** — extend `#pay-config` with CNY, or make Paddle's catalogue authoritative and derive
   both prices from it. The plan forbids two competing sources.
2. **Whether a deployed `robots.txt` overrides the Cloudflare one.** Prove it by fetching the live URL after
   deploying, exactly as B3 was proven — a source file is not evidence of what the edge serves.
3. **Which contact is canonical**, and whether `samora@` stays in the licence document or becomes `hello@`.
4. **Whether KSh stays non-machine-readable** — it must, because KES is not a Paddle currency and an `Offer` naming it
   would be a false price.

---

## 5. What L1 does not claim

- No file was changed for this phase. The storefront is exactly as deployed at Pages `14fce7c5`.
- No JSON-LD, canonical, sitemap or robots file has been written.
- Whether any of the above is *sufficient* for a specific agent or crawler is untested — L3 adds the machine-read
  tests that would answer that.
