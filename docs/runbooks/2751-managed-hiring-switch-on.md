# Runbook: switch on Managed Hiring, pilot first (#2751 items 4 to 13)

**Who:** Divyanshu applies the migration. The owner (or Prakash) sets the production secret and lists the pilot company. Not a normal deploy step. D5: ship off, pilot first, no staging. Every step below is an owner act.

API contract: `docs/api/managed-hiring-api-reference.md`. Switch: `MANAGED_HIRING_ROLLOUT` in `docs/environment-variables.md`.

## What production runs after the deploy

| Switch                   | Value          | What it means                                                                                                                                                                                                                  |
| ------------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MANAGED_HIRING_ROLLOUT` | absent = `off` | Every `/payer/managed-hiring/*` route answers 404, the `/admin/managed-hiring/*` routes answer 404, the sweep idles, and the contact-cost read never names the tracker. Nothing reads or writes the `managed_hiring_*` tables. |
| `PAYMENTS_ENABLE_REAL`   | as today       | The company routes also need real payments. While they are off, Managed Hiring is not offered even with the switch on.                                                                                                         |

The deploy changes nothing a company or an admin can see.

## Before anything: prerequisites

- [ ] **The `managed_hiring` migration is applied in production** (step 1). The switch must not move off `off` before it is.
- [ ] **Real payments are live for the pilot company**, through #2749's switch-on (`docs/runbooks/2749-switch-on.md`): `PAYMENTS_ENABLE_REAL=true`, the three Razorpay secrets, and automatic capture.
- [ ] **Invoices issue for captured payments** (#2749 part 4). A Managed Hiring payment is a `payment_orders` row of kind `managed_hiring` on the same settle path, so it gets its invoice from the same hook. Do not take real money before invoices exist.
- [ ] **`CREDIT_RULES_ROLLOUT` is on for the pilot company.** The tracker's free contact is a row of the #2750 cost rule. Without the rules, the company pays the old one credit per open, tracker or not.
- [ ] **Rishi's screens** for the company (quote, checkout, tracker, callback) and for the desk are deployed (the `[Frontend]` issue linked on the PR).

## Step 1 — apply the migration (production SQL, Divyanshu)

Apply the file `packages/db/migrations/<slot>_managed_hiring.sql` exactly as merged, after every lower-numbered slot. Run it in ONE transaction with a lock timeout, so `payment_orders_product_kind_chk` is never dropped without its replacement:

```sql
BEGIN;
SET LOCAL lock_timeout = '3s';
-- paste the migration file's statements here
COMMIT;
```

On `55P03` (lock timeout), run it again. Then check:

```sql
SELECT to_regclass('public.managed_hiring_orders'), to_regclass('public.managed_hiring_interest'),
       to_regclass('public.managed_hiring_callback_requests');
SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'payment_orders_product_kind_chk';
-- expect: CHECK ((product_kind = ANY (ARRAY['credit_pack'::text, 'managed_hiring'::text])))
SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
WHERE relname IN ('managed_hiring_orders', 'managed_hiring_interest', 'managed_hiring_callback_requests');
-- expect: t / t for all three
```

Record it in the migration ledger as for every applied migration.

## Step 2 — list the pilot company (production SQL)

Adding the row changes nothing while the switch is `off`.

```sql
BEGIN;
INSERT INTO feature_pilot_payers (feature, payer_id, added_by, reason) VALUES
  ('managed_hiring', '<tenant key>', 'owner_sql', '#2751 pilot: staff test company')
ON CONFLICT (feature, payer_id) DO NOTHING;
COMMIT;
```

`<tenant key>` is the company's org anchor payer id, the same key #2749's pilot uses.

## Step 3 — set the switch to `pilot`

```bash
gh secret set MANAGED_HIRING_ROLLOUT --env production --body pilot
```

Then redeploy (re-run the latest `main` deploy). The deploy preflight refuses any value other than `off`, `pilot`, `on` or empty. Confirm `https://52-66-102-53.sslip.io/health` reports the deploy's sha.

## Step 4 — the pilot walk

Do this as the pilot company, on a live job:

- [ ] **Quote:** `GET /payer/managed-hiring/quote?job_posting_id=<job>` shows the right tier and price. A 1–5 vacancy fresher job is `standard` at 472000 paise; a 6–10 vacancy or 3+ year job is `large` at 944000 paise. An 11+ vacancy job shows `offer: "callback"`.
- [ ] **Pay:** start a checkout with an `Idempotency-Key` and pay. The order turns `active` with `due_at` the end of the 7th working day after the payment day. `managed_hiring.order_activated` is on the spine, the company receives the "has started" email, and the invoice is issued.
- [ ] **Replay:** replaying the webhook delivery changes nothing.
- [ ] **Desk:** add a phone-confirmed worker. He shows on the company's order with the count, and opening him costs 0 credits (the balance is unchanged).
- [ ] **Agency:** an agency account gets a 403 `agency_account` on the quote.
- [ ] **Callback:** an 11+ vacancy job's callback request shows in `GET /admin/managed-hiring/callback-requests` and on the dashboard's breach counter.

## Watching

- The sweep runs every 15 minutes. It logs `managed hiring sweep: due=… moved=…` when it moves an order.
- `managed_hiring.order_closed_unmet` and `managed_hiring.callback_requested` count on the admin dashboard's breach counter. Each needs a person to call the company. There is no automatic refund.

## Rollback

```bash
gh secret set MANAGED_HIRING_ROLLOUT --env production --body off
```

Then redeploy. New orders and the desk routes stop. An order already paid still activates (the settle path is never gated), and the stored orders stay. The migration can stay applied; its rollback is in its header.
