# ADR-0065: Credit money in paise, GST, expiring credit lots, pack validity, and the retired products

- **Status:** Proposed — awaiting owner sign-off (Akshit for the brief's rulings and the open questions in §6; Prakash as the other backend developer and the one who switches). No switch in this ADR is armed in production before it is signed.
- **Date:** 2026-11-17
- **Owner:** Divyanshu (Backend Platform).
- **Issue:** #2749 (brief 4C.1–4C.4 and 4G; plan section 14). Built in parts: credit lots (PR 1), the catalogue and GST (PR 2), checkout (PR 3), the switch-on and the dropped products (PR 5a, this ADR's last part). Invoices are part 4 and not decided here (§5).
- **Amends:**
  - [ADR-0013](0013-monetization-and-config-driven-pricing-engine.md) — §A.3 item 5 and the pricing contract ("integer ₹ amounts", whole rupees, never paise); §A.5 (the credit packs absorbed as `contact_unlock`, with the 14-day window as the only time a pack carries); Decision B (posting plans and boosts as paid products) and §A.3 item 2 (offers and coupons); Decision E (posting, boost and capacity bought by direct mock purchase).
  - [ADR-0016](0016-payer-hiring-capacity.md) — hiring capacity as a product for sale.
  - [ADR-0010](0010-contact-unlock-and-reveal.md) §D5 — the wallet as one balance (`payer_credits`), and real payments as one global switch.

## 1. Context

The brief (section 2, 4C, 4G) sells one thing: credits, in packs, with GST on top. Each pack's credits last a fixed time, two packs running spend the one that expires first, the Annual pack goes on sale on 1 April 2027, and everything else that was paid before (posting plans, boosts, hiring capacity, quota top-ups, offers and coupons, a single-unlock price) is dropped. Posting, searching and seeing who applied stay free.

What the code did before #2749: the catalogue priced every product in whole rupees and nothing carried tax; a wallet was one balance with no expiry; a pack was either in the catalogue or not; real Razorpay checkout (ADR-0010 §D5) was one global switch, `PAYMENTS_ENABLE_REAL`, off in production, and beside it the mock route granted any pack for free; posting plans, boosts, capacity and top-ups were sold by mock purchase with no real-payments path at all (GAP-PAY-05).

## 2. Earlier rulings this ADR replaces

| Today in ADR-0013 / the code                                                                     | Brief                                                                         | Part                          |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- | ----------------------------- |
| Money is whole rupees, never paise (ADR-0013 §A.3; `packages/pricing/src/types.ts`)              | GST needs paise: new paise columns and fields beside the rupee ones (§3.1)    | 2, 3 (built)                  |
| No tax anywhere                                                                                  | 18% GST on every pack, shown as `₹999 plus GST (₹1,179)` (§3.2)               | 2, 3 (built)                  |
| A wallet is one balance with no expiry                                                           | Expiring lots, spent soonest-expiring first, one ledger line per event (§3.3) | 1 (built)                     |
| A pack's only time is the 14-day contact window (`windowDays`)                                   | Each pack's credits last its validity; Annual on sale from 1 Apr 2027 (§3.4)  | 2 (built)                     |
| Posting plans, boosts, capacity, top-ups, offers and coupons are for sale (ADR-0013 B, ADR-0016) | None of them is sold (§3.5)                                                   | 5a (this PR, behind a switch) |
| Real checkout is one global switch                                                               | Pilot first, company by company (D5, D15) (§3.6)                              | 5a (this PR, behind a switch) |

## 3. Decision

### 3.1 Money in integer paise, in new columns beside the rupee columns

Every new money field is an integer number of **paise**; no float ever touches money. The rupee contract of ADR-0013 is kept, not replaced: a catalogue price (`priceInr`) stays whole rupees, and so does every existing rupee column. Paise appear only beside them:

- the catalogue's price line on each pack (`GET /payer/pricing/catalog`, `price.taxablePaise` … `totalPaise`, `gstRateBps`);
- `payment_orders` (migration 0176): `taxable_paise`, `gst_paise`, `round_off_paise`, `total_paise`, `gst_rate_bps`, all five or none, with `total_paise = taxable + gst + round_off = amount_inr × 100`. `amount_inr` keeps the whole-rupee **total** (the issue's money-unit default).

The server decides price, tax and credits. A client never names an amount; `expected_price_inr` is only a confirmation the server can refuse (#2085), and it is the list price before GST.

### 3.2 GST: 18%, the rounding rule, the display line

One pure function (`packages/pricing/src/gst.ts`) prices every pack:

1. taxable = price × 100 (paise, exact);
2. GST = taxable × 1800 ÷ 10,000, rounded half-up to the paisa;
3. total = taxable + GST, rounded half-up to the whole rupee;
4. round-off = total − taxable − GST (from −49 to +50 paise).

₹999 gives taxable 99,900, GST 17,982, round-off 18, total 1,17,900 (₹1,179); the same rule gives ₹1,887, ₹3,539 and ₹11,799. Every price is displayed as `₹999 plus GST (₹1,179)` (B4C-06). The catalogue's line, the order's charge and the stored order columns are the same computation, so shown equals charged by construction. Whether an invoice prints a round-off line or rounds the tax itself is the accountant's question (§6); the total does not change.

### 3.3 Credit lots with expiry, spent soonest-expiring first

A wallet's balance is a set of lots (`credit_lots`, migration 0174): one per grant, each with what it granted, what is left and an optional expiry. Per wallet (the tenant key, ADR-0053): `payer_credits.balance = Σ credits_remaining = Σ credit_ledger.delta`. Every writer goes through `packages/db/src/credit-wallet.ts` under the wallet row lock.

- A spend takes one credit from the lot that expires soonest (a lot that never expires last), one ledger line naming the lot (B7-08).
- A lot past its date is closed once, with one `expired` ledger line, by whichever comes first: the BullMQ sweep or the spend path.
- Existing balances became one `legacy` lot per wallet with no expiry (the backfill in 0174). What happens to them at switch-over is an open owner question (§6).

### 3.4 Pack validity, the on-sale date, the hidden pack

A credit-pack tier carries, beside the old `windowDays` (kept for older readers):

- `validityDays` — how long its credits last, stamped on the order at creation and applied to the lot at settle (database clock);
- `onSaleFrom` (`YYYY-MM-DD`) — off sale until 00:00 IST that day;
- `offered: false` — off sale.

`GET /payer/pricing/catalog` lists only packs on sale, rebuilt from a whitelist so a hidden pack and any new tier field never ship; a purchase accepts only a pack the catalogue lists and has on sale (old codes 404 and stay readable as history). The Annual pack lives only in the database row, never in `DEFAULT_CATALOG` (the repository is public). Publishing the brief's packs is `docs/runbooks/2749-publish-brief-credit-packs.md`.

### 3.5 The dropped products and their switch

One boolean, `RETIRED_PRODUCTS_OFF_SALE` (default `false`: still on sale; ready to retire, the owner switches it). While it is `true`:

- **The payer catalogue** lists credit packs only. Posting plans (`job_posting`), boosts (`job_boost`, the retired `all_candidates` tier included), hiring capacity (`hiring_capacity`) and quota top-ups (`quota_topup`) are absent from `products` and from `prices`. Offers and coupons go with them: a credit pack is charged at list price and never takes an offer or a coupon, and a coupon never ships in the catalogue anyway.
- **Every purchase route** for them answers a bare 404 (`error.message` `"Not Found"`): `POST /payer/job-postings/:id/plan|boost|quota-topup`, `POST /payer/capacity`, and the ops `POST /job-postings/:id/plan|boost`. `PostingPlansService` refuses before any read, lock, price, payment event or row of its own. On the payer routes two things run first, in the controller: the posting-ownership read (plan, boost, top-up; an unknown or foreign posting is the same neutral 404) and the `Idempotency-Key` reservation, so a refusal under a key is stored and replayed for that key's 180-second window. Coupon redemption and offer application only ever happened inside these purchases, so they stop with them. The check is in `PostingPlansService`, first in every purchase method and again in its one price path (a static test pins both).
- **It is an allow-list.** Only the credit pack survives; a product kind added to the catalogue later is off sale too while the switch is on, until it is named.
- **History stays.** Plans, boosts, top-ups and capacity already bought run to their end date, and every read of them (posting stats, the capacity view, payment history, the admin pages) is unchanged. Nothing is deleted from the catalogue row.
- **Credit packs are unaffected.**

It must be `true` **no later than real payments** (hardening 7): these products have no real-payments path, so with packs costing money they would stay free.

**No single-unlock price in API output (B4C-08).** No API response carries a per-unlock price: no `₹40`, no unit price, no `contact_unlock` tier sold as one credit. `UNLOCK_UNIT_PRICE_INR` (`packages/db/src/credit-packs.ts`) is unused and reaches no response. The dormant agency payout basis (`AGENCY_PAYOUT_UNLOCK_BASIS_INR`, ₹40) reaches only the agency earnings route, which is a 404 while `AGENCY_PAYOUTS_ENABLED` is off; it is left alone (BB-D-08 decides it). The posting form's ladder rungs (`GET /payer/posting-trades`) carry a `priceTier` label (`lower` / `higher`, the unlock price hook, display-only) with no amount; it is not removed here because payer-web's contract requires the key (§7).

### 3.6 The pilot rollout of the new money rules

`CREDIT_CHECKOUT_ROLLOUT` (`off` | `pilot` | `on`, rollout key `credit_checkout`, #2746's helper): **the new money rules apply to this company.** Asked by `UnlockService` through `FeatureRolloutService.stateForPayer`, with the tenant key from `PayerTenantScopeService` (never a raw id). It is lazy: `off` and `on` read no membership and no list.

| Route                                                               | Rules apply to the company (`on`, or `pilot` and listed)                                                                                                                                               | Rules do not apply (`off`, or `pilot` and not listed)                   | Pilot list unreadable                                                |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `POST /payer/credits/order` (a new real order)                      | open while real payments are live; 404 otherwise                                                                                                                                                       | 404                                                                     | 404                                                                  |
| `POST /payer/credits/verify` (settle a paid order from the browser) | open while real payments are live; 404 otherwise. Not gated by the rollout: it creates no order, and the signature plus the order's stamped tenant bind it to its buyer                                | the same                                                                | the same                                                             |
| `POST /payer/credits` (free mock packs)                             | 404 (hardening 1)                                                                                                                                                                                      | open while real payments are off; 404 while live                        | 404                                                                  |
| `POST /payers/:payerId/credits` (ops grant)                         | 409 `reason: real_payments_live` while real payments are live; else 409 `reason: credit_checkout_rollout` (hardening 2)                                                                                | grants while real payments are off; 409 `real_payments_live` while live | 503 while real payments are off; 409 `real_payments_live` while live |
| `GET /payer/credits` → `checkout`                                   | `real` while real payments are live; `none` otherwise                                                                                                                                                  | `free` while real payments are off; `none` while live                   | `none`                                                               |
| `POST /payments/razorpay/webhook`                                   | not gated by the rollout; `RazorpayWebhookGuard` verifies the signature with `RAZORPAY_WEBHOOK_SECRET`, so every delivery is a 401 while real payments are not live (`getRazorpayCredentials` is null) | the same                                                                | the same                                                             |
| The ledger, stored lots and stored orders                           | never gated                                                                                                                                                                                            | never gated                                                             | never gated                                                          |

**Not gated by this switch** — two ways a company still gets credits without paying:

| Path                                               | What it grants                                                                                                                               | What limits it today                                                                                                                                                | What replaces it                                                                          |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Signup free tier (`FreeTierService.grantForPayer`) | `match_config.freeUnlockCredits` (default 50) to every new company, as a `legacy` lot that never expires; about ₹2,500 at the brief's prices | once per payer (an idempotency key on the ledger)                                                                                                                   | #2750's welcome credits (B4C-11); it must be cut or replaced before the rollout goes `on` |
| Admin grant (`POST /admin/payers/:id/credits`)     | any amount up to 10,000 per grant                                                                                                            | `AdminAuthGuard`, the `grant_credits` capability, a reason code, one `admin.action_performed` (`credits_granted`) event in the same transaction; no per-company cap | #2750's capped goodwill path                                                              |

"Real payments live" is `areRealPaymentsEnabled` (`PAYMENTS_ENABLE_REAL` plus the three Razorpay secrets). With the rollout `off` and real payments off — production today — every route is exactly what it was, with no extra read. While real payments are live, a company outside the rollout can buy nothing (both routes 404); it keeps its balance and everything free stays free. Credit grants for a company in the rules go through the capped goodwill path of #2750, not the ops route; while real payments are live the ops route grants to nobody. `GET /payer/credits` carries the same answer as `checkout` (`real` | `free` | `none`) so a front end shows the right buy button without its own copy of a payment switch.

The browser verify settles a payment only when Razorpay reports it `captured` (an `authorized` or `failed` payment is a neutral refusal and the webhook settles it on `payment.captured`), so the Razorpay account must capture automatically.

The switch decides capabilities, never stored state: setting it back to `off` closes the real checkout for NEW orders and nothing else. Lots, orders and their expiry stay; an order already paid still settles through the webhook and through `/verify`, because both need only real payments live. That is why the rollback is the rollout, never `PAYMENTS_ENABLE_REAL=false`: switching real payments off removes the webhook's secret (every delivery a 401) and closes `/verify`, so a buyer who paid minutes earlier is charged and gets nothing. Real payments go off only after every `created` or `failed` order is reconciled in the Razorpay dashboard. The switch-on order, from test keys to everyone, is `docs/runbooks/2749-switch-on.md`.

## 4. Consequences

- Two money units now live side by side. A reader of a rupee column gets the whole-rupee total; only the new fields carry paise.
- A company's credits can now run out by date, not only by spending; the company terms must say so ("Credits expire on the date shown at purchase.", brief 9, a lawyer must check).
- While the pilot runs with real payments live, companies outside it cannot buy credits at all. That is deliberate (no free packs beside a paywall); the pilot should be short.
- With `RETIRED_PRODUCTS_OFF_SALE` on, payer-web's plan, boost, capacity and top-up buttons would meet a 404: the front end hides them first (§7). payer-app sells none of them (its capacity and jobs screens only read).

## 5. Out of scope

- **Invoices** (#2749 part 4, item 8): `seller_tax_config`, `invoices`, the gap-free number per financial year and the PDF. It needs the seller of record's details (item 1), which Akshit must name. Real payments do not switch on before it ships.
- **The app's web checkout link** (item 12): a one-time, short-lived link from the mobile app to web checkout. CLAUDE.md §12 keeps payment screens out of the apps.
- **Moving catalogue edits behind admin auth** (hardening 11): `PUT /pricing/catalog` still rides the shared ops token.
- **Bridging the Razorpay secrets to production**: `PAYMENTS_ENABLE_REAL` and the three Razorpay secrets are not bridged from GitHub secrets to the container today (§7).
- **A refund path** (BB-D-05) and the reconciliation jobs (#2773, #2774).

## 6. Open owner questions (each built with the default)

- Expiry to the instant, or to the end of the IST day (default: the instant).
- Annual's validity: 365 days or a calendar year (default: 365 days).
- What legacy balances become at switch-over (default: one `legacy` lot per company that expires 30 days later, and no welcome credits on top; it conflicts with BB-D-05's welcome rule, recorded on the issue).
- The invoice's round-off line, or tax rounded to the rupee (the total is the same).

## 7. Rollout, rollback and what others must do

- **Defaults ship dark.** Both switches default off/false; on deploy nothing in production changes.
- **Prerequisites before real payments**, in `docs/runbooks/2749-switch-on.md`: the Razorpay secrets bridged in their own reviewed PR; the Razorpay account on automatic capture; invoices live; payer-web showing `price.display` before checkout (BB-R-03); payer-web hiding the retired products' buttons and no longer computing a per-unlock price in the browser (#2744, PR #2792); `RETIRED_PRODUCTS_OFF_SALE=true` no later than `PAYMENTS_ENABLE_REAL`.
- **Rollback:** `CREDIT_CHECKOUT_ROLLOUT=off` with `PAYMENTS_ENABLE_REAL` left on, then a redeploy: no new order, and every paid order still settles. `PAYMENTS_ENABLE_REAL=false` only after every open order is reconciled (§3.6; the runbook lists the query). `RETIRED_PRODUCTS_OFF_SALE=false` puts the products back on sale. No migration is involved; stored lots, orders and their expiry are never undone.
- **Accepted for the pilot, prerequisites for everyone** (the runbook records the owner's acceptance): hardening 6 (no webhook inbox or reconciliation job, #2773; a daily hand check meanwhile) and hardening 11 (catalogue edits ride the shared ops token; `pricing.changed` watched meanwhile). Also before `on`: the signup grant cut or replaced (#2750).
- **Front end (Rishi):** payer-web shows its buy button from `GET /payer/credits`'s `checkout`, not from its own `PAYMENTS_ENABLE_REAL`; it must accept a catalogue with no product (with this switch on and no pack sellable, its `.min(1)` parse falls back to the built-in catalogue and shows the retired products again); and its posting-trades contract requires `priceTier` on every ladder rung, which should become optional before the backend drops it in a later PR.
- **Ops console (`apps/web`, Prakash):** its credits top-up shows any refusal as "Top-up failed (unknown pack…)"; it needs a message for the 409s `real_payments_live` and `credit_checkout_rollout`.

## Related

- ADR-0013 (the pricing engine this amends), ADR-0016 (hiring capacity), ADR-0010 (the unlock spine and the payment seam), ADR-0053 (the tenant key), ADR-0064 (what a credit opens).
- #2746 (the rollout helper), #2750 (credit rules and the goodwill path), #2751 (managed hiring, a non-pack product kind), #2744 (payer-web credits page).
- `docs/runbooks/2749-publish-brief-credit-packs.md`, `docs/runbooks/2749-switch-on.md`, `docs/environment-variables.md`.
