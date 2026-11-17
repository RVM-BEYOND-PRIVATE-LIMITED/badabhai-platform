# Runbook: switch on real credit payments, pilot first (#2749 item 10)

**Who:** Prakash (production secrets, the Razorpay account, the SQL editor), with Divyanshu for the
checks. **Not** a normal deploy step. Decided in ADR-0065 §3.6; the switches are described in
`docs/environment-variables.md`.

D5 and D15: pilot first, no staging, and nothing is switched off by the issue itself. Every step
below is an owner act.

## What production runs today

| Switch                      | Value            | What it means                                                                                                                                        |
| --------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PAYMENTS_ENABLE_REAL`      | off              | Real checkout (`POST /payer/credits/order`, `/verify`) answers 404 for everyone.                                                                     |
| `CREDIT_CHECKOUT_ROLLOUT`   | absent = `off`   | The new money rules apply to no company: free mock packs (`POST /payer/credits`) and the ops grant (`POST /payers/:payerId/credits`) work as before. |
| `RETIRED_PRODUCTS_OFF_SALE` | absent = `false` | Posting plans, boosts, capacity, top-ups, offers and coupons are still on sale (mock-paid).                                                          |

Deploying this PR changes none of it.

## The gates, once switched (ADR-0065 §3.6)

| Route                                             | Company in the rules (`on`, or `pilot` and listed) | Company not in the rules                         | Pilot list unreadable |
| ------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------ | --------------------- |
| Real checkout (`/payer/credits/order`, `/verify`) | open while real payments are live                  | 404                                              | 404                   |
| Free mock packs (`POST /payer/credits`)           | 404                                                | open while real payments are off; 404 while live | 404                   |
| Ops grant (`POST /payers/:payerId/credits`)       | 409 `reason: credit_checkout_rollout`              | grants, as before                                | 503                   |

The Razorpay webhook, `GET /payer/credits`, the ledger, stored lots and stored orders are never
gated. **While real payments are live, a company outside the rollout can buy nothing** (both credit
routes answer 404). It keeps its balance, and posting, search and applicants stay free. Keep the
pilot short.

## Before anything: prerequisites

Do not start step 3 until every box is ticked.

- [ ] **The Razorpay secrets reach the container.** Today they do not: `PAYMENTS_ENABLE_REAL` is
      declared in `docker-compose.staging.yml` but not bridged in `ci.yml`, and
      `PAYMENTS_PROVIDER_KEY`, `PAYMENTS_PROVIDER_SECRET` and `RAZORPAY_WEBHOOK_SECRET` are not
      declared on the `api` service at all. They are bare `.optional()` fields, so a `${VAR:-}`
      pass-through would stop the api booting; they need `optionalSecret()` first (#858). That is
      its own reviewed PR (config + compose + `ci.yml` `env:`/`envs:` + the deploy preflight + the
      taxonomy guard). Setting the GitHub secrets alone does nothing.
- [ ] **Invoices are live** (#2749 part 4): merged, its migration applied, the seller row filled.
      Every payment needs a GST invoice.
- [ ] **payer-web is ready** (Rishi): the purchase confirmation shows the pack's `price.display`
      (`₹999 plus GST (₹1,179)`) before Razorpay opens (BB-R-03); it shows no per-unlock price and
      no value framing (#2744, PR #2792); and the plan, boost, capacity and top-up buttons are gone
      or hidden, because they will answer 404 once `RETIRED_PRODUCTS_OFF_SALE` is on. The same for
      payer-app's capacity screen and its job-plan purchase (a release, so earlier).
- [ ] **The brief's packs are published** and the `DEFAULT_CATALOG` PR is merged
      (`docs/runbooks/2749-publish-brief-credit-packs.md`), and every check in that runbook's
      "Switch-on checks" passes (order amount = `price.totalPaise` for every pack on sale; the
      `held` path is watched).
- [ ] **Migrations 0174 and 0176 are applied** (they are, parts 1–3 are live). This PR adds none.
- [ ] **The owner questions are answered or the defaults accepted** (ADR-0065 §6): what legacy
      balances become, expiry to the instant or the end of the day, Annual's validity.
- [ ] **The staff test company exists** and is marked a test account
      (`payers.is_test_account = true`, through the admin numbers route of #2755 or by SQL), so the
      weekly numbers leave it out.

## Step 1 — test keys, on a test stack (never production)

A local or test stack with its own database (there is no staging). Set `PAYMENTS_ENABLE_REAL=true`,
the `rzp_test_*` key, its secret and a webhook secret, `CREDIT_CHECKOUT_ROLLOUT=pilot`, and list
one test company (step 2's SQL against the test database). Then:

1. As the listed company: `GET /payer/pricing/catalog` shows the brief's packs with their GST lines;
   `POST /payer/credits/order` with an `Idempotency-Key` returns `amount: 117900` for Starter; pay
   in test checkout; the webhook settles once (one ledger line, one lot of 20 credits expiring 30
   days later); a replayed webhook adds nothing; `/verify` reports the same balance.
2. As the listed company: `POST /payer/credits` → 404. The ops grant for it → 409
   `credit_checkout_rollout`.
3. As a company **not** listed: `POST /payer/credits/order` → 404, `POST /payer/credits` → 404 (real
   payments live), the ops grant → 200 as before.
4. A capture of the wrong amount moves the order to `held` and grants nothing (`payment.held`).
5. Set `CREDIT_CHECKOUT_ROLLOUT=off`: the order route answers 404 for the listed company too, and
   the lot from step 1 is still there with its expiry.

## Step 2 — list the pilot company (production SQL)

Adding the row changes nothing while the switch is `off`. In the BadaBhai SQL editor:

```sql
BEGIN;
INSERT INTO feature_pilot_payers (feature, payer_id, added_by, reason) VALUES
  ('credit_checkout', '<tenant key>', 'prakash', '#2749 pilot: staff test company')
ON CONFLICT (feature, payer_id) DO NOTHING;
COMMIT;
SELECT feature, payer_id, added_by, reason, created_at
FROM feature_pilot_payers WHERE feature = 'credit_checkout' ORDER BY created_at;
```

`<tenant key>`: with `PAYER_ORG_TENANCY_MODE=on` it is the company's anchor `payers.id`, and every
team member inherits the place; in `off` / `shadow` it is the login itself, so list each login that
should buy. The list is read on every request; a row added or deleted counts from the next one.

## Step 3 — the dropped products off sale (no later than step 4)

Hardening 7: plans, boosts, capacity and top-ups have no real-payments path, so they must be off
sale no later than the moment packs cost money. Do it now, or in the same redeploy as step 4:

```sh
gh secret set RETIRED_PRODUCTS_OFF_SALE --env production --body true
```

then redeploy. Check: `GET /payer/pricing/catalog` lists credit packs only (no `job_posting`,
`job_boost`, `hiring_capacity`, `quota_topup`, no offer); `POST /payer/capacity` and
`POST /payer/job-postings/<id>/plan` answer 404; an existing posting's stats and
`GET /payer/capacity` still read. Undo: set it to `false` and redeploy.

## Step 4 — pilot on, real payments on (one redeploy)

With the bridge PR merged and the live keys in the `production` environment:

```sh
gh secret set PAYMENTS_PROVIDER_KEY --env production       # rzp_live_*, entered at the prompt
gh secret set PAYMENTS_PROVIDER_SECRET --env production    # entered at the prompt
gh secret set RAZORPAY_WEBHOOK_SECRET --env production     # entered at the prompt
gh secret set CREDIT_CHECKOUT_ROLLOUT --env production --body pilot
gh secret set PAYMENTS_ENABLE_REAL --env production --body true
```

then redeploy, and check that `GET /admin/finance/summary` (admin-web's finance page) reports
`payments.mode: "real"` with `blocked_reason: null`; `/health` does not report payments. Never
paste a secret value into a command line, an issue or a log. Point the Razorpay dashboard's webhook at
`POST /payments/razorpay/webhook` with the same webhook secret.

From the first request on the new container: the listed company can pay through Razorpay, its free
packs and the ops grant are closed; every other company can buy nothing (both credit routes 404)
and the ops grant still works for it.

## Step 5 — one staff test purchase, marked `is_test`

Plan section 14: one live payment proved before launch.

1. As the staff test company, buy Starter (`₹999 plus GST (₹1,179)`) through payer-web.
2. Check: the order is `paid` with `total_paise = 117900`; one `payment.captured` with
   `real_call: true`; the lot holds 20 credits expiring 30 days after the settle; one GST invoice
   can be downloaded; `SELECT id FROM payment_orders WHERE status = 'held'` is empty.
3. Mark the lot as test traffic. The settle does not stamp `credit_lots.is_test` yet (no writer
   copies `payers.is_test_account` onto a lot), so it is a hand step:

   ```sql
   UPDATE credit_lots SET is_test = true
   WHERE payment_order_id = '<payment_orders.id of the test order>' AND payer_id = '<tenant key>';
   ```

4. A refund, if wanted, is made in the Razorpay dashboard (no refund path until BB-D-05); the
   credits stay on the test company's wallet.

## Step 6 — everyone

When the pilot is proved:

```sh
gh secret set CREDIT_CHECKOUT_ROLLOUT --env production --body on
```

then redeploy. Every company: real checkout open, free mock packs closed, the ops grant refused
(409); credit grants go through the goodwill path (#2750). The pilot rows can stay.

## Rollback

`CREDIT_CHECKOUT_ROLLOUT` back to `off` (or one company's row deleted), then a redeploy. No code
change, no migration.

**What it does:** the real checkout answers 404 again for new orders and new verifies; the ops
grant works again; the free mock packs reopen only if `PAYMENTS_ENABLE_REAL` is also off.

- To stop taking money entirely, also set `PAYMENTS_ENABLE_REAL=false`. That returns production to
  today: the free mock packs reopen for every company.
- To stop taking money **and** keep the free packs closed, leave `PAYMENTS_ENABLE_REAL=true` and set
  the rollout to `off`: then no company can buy credits at all.

**What it does not undo:**

- Lots already granted stay, with their expiry, and keep expiring on the sweep.
- Orders stay as they are (`paid`, `held`, `created`). An order created before the rollback still
  settles if Razorpay reports its capture: the webhook is never gated. Its `/verify` answers 404,
  so the credits arrive through the webhook only.
- Invoices, ledger lines and events stay.
- `RETIRED_PRODUCTS_OFF_SALE` is separate: set it to `false` to put the dropped products back on
  sale.

Never roll the code back below #2749 PR 2 while the catalogue row carries `onSaleFrom` or `offered`
(`docs/runbooks/2749-publish-brief-credit-packs.md`).
