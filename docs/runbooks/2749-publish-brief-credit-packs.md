# Runbook: put the brief's credit packs on sale (#2749)

**Who:** the owner (or whoever holds the ops token), at go-live. **Not** a normal deploy step.

## What production serves today

Production has **no `pricing_catalog` row** (read 2026-11-16). With no row, the pricing engine serves
`DEFAULT_CATALOG` from `packages/pricing/src/defaults.ts`. So companies see, and can buy, the old
packs: `pack_50` ₹2,000, `pack_200` ₹8,000 and `pack_1000` ₹32,000.

Since #2749 (PR 2):

- the payer catalogue (`GET /payer/pricing/catalog`) lists only packs **on sale**, each with its GST
  price line;
- a purchase (`POST /payer/credits`, `POST /payer/credits/order`, the ops
  `POST /payers/:payerId/credits`) accepts **only** a pack the active catalogue lists and has on sale.
  Old codes (`pack_10`, `pack_25`, and after this publish `pack_50` / `pack_200` / `pack_1000`) return
  `404`. They stay readable wherever they are history (ledger, payment history, admin views);
- if a stored catalogue row ever fails validation, **no pack is sold or listed** (it does not fall
  back to selling the default packs). With no row at all, the default packs sell, as today.

A pack is off sale when its catalogue entry has `offered: false`, or before 00:00 IST on its
`onSaleFrom` date (`YYYY-MM-DD`).

> **The GST price line is what a company pays (since #2749 part 3).** The catalogue shows each
> pack's `price.totalPaise` and `price.display` (`₹999 plus GST (₹1,179)`); an order is created for
> `price.totalPaise` (₹1,179), and the mock route stamps the same total on the ledger.
> `expected_price_inr` is still the list price before GST (₹999). Note what this changes for the
> **default** packs production serves today: `pack_50` / `pack_200` / `pack_1000` now charge
> ₹2,360 / ₹9,440 / ₹37,760 (₹2,000 / ₹8,000 / ₹32,000 plus GST) on the real route and stamp those
> totals on the mock route's ledger lines.

## This is a go-live decision

Publishing a catalogue row takes effect **at once, with no deploy**: the next catalogue read and
the next purchase use it. It changes what every company sees and pays (employers and agencies
alike, B2-48). Do it only when the owner has decided to switch prices.

Check these first:

- **Free packs.** With `PAYMENTS_ENABLE_REAL` off, `POST /payer/credits` grants any on-sale pack
  with no money taken. After the publish, that means the brief's packs (hardening list item 1 in the
  issue's private notes).
- **Pack codes are permanent.** Once a pack is sold, its code is on ledger and order rows for good.
  The codes below (`pack_starter`, `pack_standard`, `pack_big`, `pack_annual`) are a proposal; rename
  them before the first publish if you want different ones. Codes are lowercase letters, digits and
  `_`.
- **Validity.** `validityDays` is how long credits from a pack last. Since PR 3 of #2749 a purchase
  applies it: the mock route's lot expires `validityDays` days after the grant, and a real order
  stamps it at creation (`payment_orders.credit_validity_days`) and its lot expires that many days
  after the settle — both counted by the database clock. So publishing this row is what starts credit
  expiry (the default packs set no validity). `windowDays: 14` is the old contact-access window.
  Every pack keeps it because older readers still require it.
- **The ops console** (`apps/web` → Pricing → credits top-up) lists every credit-pack entry in the
  catalogue, including Annual. Before 1 April 2027 a top-up of Annual returns `404`.
- **Owner question — Annual's validity: 365 days, or a calendar year?** The brief says "12 months";
  this runbook uses `validityDays: 365` (the default until the owner decides otherwise). Every
  Annual sold between 1 April 2027 and 29 February 2028 spans 29 February 2028, so 365 days ends one
  day before the same date a year later (bought 1 April 2027 → ends 31 March 2028, not 1 April 2028).
  If the owner wants a true calendar year (or calendar months for any pack), that needs code
  support: `validityDays` is a count of days and there is no month unit. It is not in this PR.

## The publish

`PUT /pricing/catalog` replaces the **whole** catalogue, so the body carries every other product over
from `DEFAULT_CATALOG` unchanged. The API validates the whole body with `catalogSchema` (a bad value
is a `400` and nothing is stored). The service validates it again, stores it as the next revision,
deactivates the previous one, and emits `pricing.changed` (field names only, never values).

On a credit-pack tier this write also refuses, with a `400` that names the field:

- an **unknown key**. A misspelt `onsaleFrom`, `on_sale_from` or `Offered` would otherwise be
  dropped, and Annual would go on sale the moment the row is stored;
- a `priceInr` above `10,000,000`.

- **Auth:** header `x-internal-service-token` (the shared `INTERNAL_SERVICE_TOKEN`).
- **`updated_by`:** a uuid naming whoever is publishing. Replace the zero uuid below.

```json
{
  "updated_by": "00000000-0000-4000-8000-000000000000",
  "catalog": {
    "version": 1,
    "floorPriceInr": 0,
    "products": [
      {
        "kind": "posting",
        "code": "job_posting",
        "tiers": [
          {
            "code": "standard",
            "priceInr": 1000,
            "validityDays": 14,
            "applicantVisibilityQuota": 10
          },
          { "code": "pro", "priceInr": 2500, "validityDays": 30, "applicantVisibilityQuota": 30 }
        ]
      },
      {
        "kind": "boost",
        "code": "job_boost",
        "tiers": [
          { "code": "boost_7", "priceInr": 499, "boostDays": 7 },
          { "code": "boost_15", "priceInr": 999, "boostDays": 15 },
          { "code": "boost_30", "priceInr": 1799, "boostDays": 30 },
          { "code": "all_candidates", "priceInr": 1200, "boostDays": 2 }
        ]
      },
      {
        "kind": "credit_pack",
        "code": "contact_unlock",
        "tiers": [
          {
            "code": "pack_starter",
            "priceInr": 999,
            "credits": 20,
            "windowDays": 14,
            "validityDays": 30
          },
          {
            "code": "pack_standard",
            "priceInr": 1599,
            "credits": 40,
            "windowDays": 14,
            "validityDays": 60
          },
          {
            "code": "pack_big",
            "priceInr": 2999,
            "credits": 100,
            "windowDays": 14,
            "validityDays": 90
          }
        ]
      },
      {
        "kind": "capacity",
        "code": "hiring_capacity",
        "tiers": [
          { "code": "cap_5", "priceInr": 5000, "maxActiveVacancies": 5, "validityDays": 30 },
          { "code": "cap_15", "priceInr": 12000, "maxActiveVacancies": 15, "validityDays": 30 }
        ]
      },
      {
        "kind": "quota_topup",
        "code": "quota_topup",
        "tiers": [
          { "code": "topup_10", "priceInr": 1000, "additionalVisibilityQuota": 10 },
          { "code": "topup_30", "priceInr": 2500, "additionalVisibilityQuota": 30 }
        ]
      }
    ],
    "offers": [],
    "coupons": []
  },
  "change": { "change_type": "plan", "entity_code": "contact_unlock", "changed_fields": ["tiers"] }
}
```

The posting, boost, capacity and top-up products are carried over exactly as `DEFAULT_CATALOG` holds
them today. Taking them off sale is item 11 of #2749, a separate switch. Do not drop them here.

### The Annual pack: entered at publish time, database row only

Annual must **never** go in code (`DEFAULT_CATALOG`; the repository is public). It goes only in the
database row. When you publish, append this entry to the `contact_unlock` `tiers` array in the body
above:

```json
{
  "code": "pack_annual",
  "priceInr": 9999,
  "credits": 360,
  "windowDays": 14,
  "validityDays": 365,
  "onSaleFrom": "2027-04-01"
}
```

Until 00:00 IST on 1 April 2027, Annual is missing from `GET /payer/pricing/catalog`, and an order for
it returns `404`. From then on it is listed and sells, with no further publish.

### After publishing, check

1. **First, before anything else:** the `PUT` response's `catalog` shows the `contact_unlock` tier
   `pack_annual` with `onSaleFrom: "2027-04-01"`. If the date is missing, Annual is already on sale:
   publish again at once without Annual, then find out why.
2. `GET /pricing/catalog` (ops token): `source: "db"` and the new `revision`.
3. `GET /payer/pricing/catalog` (any company session) lists exactly three packs, with these
   `price.display` lines:
   - `pack_starter`: `₹999 plus GST (₹1,179)`
   - `pack_standard`: `₹1,599 plus GST (₹1,887)`
   - `pack_big`: `₹2,999 plus GST (₹3,539)`

   No `pack_annual` appears, and neither does any `onSaleFrom` or `offered` key. Each `price` is
   what an order for that pack charges, and each pack shows its `validityDays` (30 / 60 / 90).

4. `POST /payer/credits` with `{ "pack_code": "pack_50" }` → `404`.

**Undo:** publish again. A `PUT` with the previous catalogue (the old `contact_unlock` tiers from
`DEFAULT_CATALOG`) becomes the next revision. The API cannot remove the row. Going back to "no row"
takes a manual database change.

### ⚠️ Never roll back below this PR once the row carries `onSaleFrom` or `offered`

Once a stored row carries `onSaleFrom` or `offered`, do **not** revert to, or deploy, any build from
before #2749 PR 2 (#2866). An older build ignores both fields (its schema drops them), shows and sells
every tier, and brings back the `CREDIT_PACKS` constant fallback (`pack_10`, `pack_25`, …). It would
put **Annual on sale immediately**. If such a rollback is unavoidable, first publish a row without
Annual (and without any `offered: false` pack you do not want sold), check it, and only then roll
back.

## Switch-on checks

Before real payments (`PAYMENTS_ENABLE_REAL`) are switched on for these packs, for anyone, including
the pilot:

- **The order amount equals `price.totalPaise` for every pack on sale.** For each pack the catalogue
  lists, create an order on test keys (`POST /payer/credits/order`, with an `Idempotency-Key`) and
  compare its `amount` (paise) with that pack's `price.totalPaise` (₹999 → `117900`). Since part 3
  of #2749 they match by construction (`apps/api/src/unlocks/razorpay-payments.test.ts` pins it for
  every pack on sale); do not switch on if any differs.
- **A wrong capture is held, not granted.** A webhook whose captured `amount` is not the order total
  (or carries none, or is not INR) moves the order to `held` and grants nothing, with one
  `payment.held` event; no replay or verify can settle it. Until a refund path exists (BB-D-05), each
  held order is a refund in the Razorpay dashboard: watch `payment.held` (or
  `SELECT id FROM payment_orders WHERE status = 'held'`) from the first pilot payment.
- The rest of the issue's switch-on list (hardening items, pilot gating) still applies.

## The same go-live change: make `DEFAULT_CATALOG` the brief's three packs

`DEFAULT_CATALOG` is what sells whenever there is **no** stored row (production today, a fresh
environment, or a row removed by hand). A stored row that fails validation sells no packs at all,
but the default still decides what every other product costs in that state. While the default
still holds `pack_50` / `pack_200` / `pack_1000`, losing the row would put the old prices back on
sale. So in the same go-live change, a PR replaces its `contact_unlock` tiers with Starter, Standard
and Big exactly as above, **without Annual**. That PR also removes the `TODO(#2749 go-live)` note in
`defaults.ts`, updates `on-sale.test.ts`, which pins the old packs, and updates
`tests/e2e/helpers/credit-packs.ts`: the e2e suites seed credits by buying a `DEFAULT_CATALOG` pack
(`pack_50` and `pack_200` today) and fail once those codes are no longer sold.

Order: publish the row first (it takes effect at once), check it, then merge the `DEFAULT_CATALOG`
PR the same day. Once the row exists, the default serves only as the fallback, so merging the PR
changes nothing a company sees.

## Checking on a test stack (never production)

Use a local or test stack with its own database. There is no staging (D5, D15).

1. Publish the body above with Annual appended, but set Annual's `onSaleFrom` to **today's date in
   IST**.
2. `GET /payer/pricing/catalog` now lists `pack_annual` with
   `price.display: "₹9,999 plus GST (₹11,799)"` and `validityDays: 365`.
3. `POST /payer/credits` with `{ "pack_code": "pack_annual" }` (mock mode) → `201` with 360 credits.
4. Publish again with `onSaleFrom` set to a date in the future. Annual disappears from the catalogue,
   and the same `POST` returns `404`.

The IST boundary is covered by unit tests. A pack dated `2027-04-01` is off sale at
`2027-03-31T18:29:59Z` and on sale at `2027-03-31T18:30:00Z`
(`packages/pricing/src/on-sale.test.ts`, `apps/api/src/unlocks/payment-gateway.test.ts`).
