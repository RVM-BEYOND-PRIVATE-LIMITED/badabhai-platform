# Runbook: switch on real credit payments, pilot first (#2749 item 10)

**Who:** Prakash (production secrets, the Razorpay account, the SQL editor), with Divyanshu for the
checks. **Not** a normal deploy step. Decided in ADR-0065 §3.6; the switches are described in
`docs/environment-variables.md`.

D5 and D15: pilot first, no staging, and nothing is switched off by the issue itself. Every step
below is an owner act.

## What production runs today

| Switch                      | Value            | What it means                                                                                                                                        |
| --------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PAYMENTS_ENABLE_REAL`      | absent = `false` | Real checkout (`POST /payer/credits/order`, `/verify`) answers 404 for everyone.                                                                     |
| The three Razorpay secrets  | absent           | `PAYMENTS_PROVIDER_KEY`, `PAYMENTS_PROVIDER_SECRET`, `RAZORPAY_WEBHOOK_SECRET`: bridged since part 5b, inert while `PAYMENTS_ENABLE_REAL` is off.    |
| `CREDIT_CHECKOUT_ROLLOUT`   | absent = `off`   | The new money rules apply to no company: free mock packs (`POST /payer/credits`) and the ops grant (`POST /payers/:payerId/credits`) work as before. |
| `RETIRED_PRODUCTS_OFF_SALE` | absent = `false` | Posting plans, boosts, capacity, top-ups, offers and coupons are still on sale (mock-paid).                                                          |

Deploying part 5a (the two switches) or part 5b (the payment bridge) changes none of it.

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

Do not start step 3 until every box is ticked. One exception: steps 3 to 5 move no money and may
go ahead of "Invoices are live" (step 5 says what that costs).

- [ ] **The payment bridge (#2749 part 5b) is merged and deployed.** It makes the four payment
      values the GitHub `production` environment secrets of the same names (`ci.yml` `env:` +
      `envs:`, compose `${PAYMENTS_ENABLE_REAL:-false}` and `${NAME:-}`, the three Razorpay fields
      `optionalSecret()`), and adds the deploy preflight below. With the secrets absent it changes
      nothing. Before it, setting the secrets did nothing at all.
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

## How the payment secrets are set (read before steps 3 to 8)

**Every deploy reads the secrets as they stand when it runs**: a teammate's merge to `main`, or a
re-run. So set them in the order below, where every state in between is safe, and set
`PAYMENTS_ENABLE_REAL` **last**.

- **Values never go on a command line, in chat, in an issue or in a log.** For the three Razorpay
  values run `gh secret set NAME --env production` with no `--body` and paste the value at the
  prompt. Only the switches (`true`, `false`, `pilot`, `on`) take `--body`.
- **The `production` environment, not the repository.** A repository secret of the same name is
  shadowed and does nothing.
- **Redeploy** = re-run the deploy job of the LATEST `main` run (an older run deploys older code):

  ```bash
  RUN=$(gh run list --workflow ci.yml --branch main --event push --limit 1 --json databaseId -q '.[0].databaseId')
  JOB=$(gh run view "$RUN" --json jobs -q '.jobs[] | select(.name=="Deploy to AWS Lightsail") | .databaseId')
  gh run rerun "$RUN" --job "$JOB" && gh run watch "$RUN"
  ```

**The deploy preflight** (`scripts/deploy/staging-deploy.sh`) runs before any container moves. It
refuses the deploy, prints `::error::` naming the variable (never its value) and ends "Nothing was
deployed", when:

- `PAYMENTS_ENABLE_REAL` is `true` and any of the three Razorpay secrets is empty or blank;
- `PAYMENTS_ENABLE_REAL` is `true` and `RETIRED_PRODUCTS_OFF_SALE` is not `true` (hardening 7);
- `PAYMENTS_ENABLE_REAL` is `true` and `PAYMENTS_PROVIDER_KEY` is not `rzp_test_…` or
  `rzp_live_…` with no spaces (most likely the key secret pasted into the key slot). With the flag
  not `true` the same key only prints a `::warning::` naming `PAYMENTS_PROVIDER_KEY` and the deploy
  goes on, so a bad paste never blocks unrelated deploys, but it does block arming: fix it as soon
  as the warning appears;
- `PAYMENTS_ENABLE_REAL` is `1` (the api reads it as on, payer-web only reads `true`): use `true`.

A refused deploy leaves production exactly as it was, but every later deploy is refused too until
the secret is fixed, so fix it straight away. Armed with a `rzp_test_` key the deploy passes with a
`::warning::`: **`rzp_live_` is what production expects; `rzp_test_` is for the rehearsal in step
5 only.**

## Step 1 — the route logic, with test keys, on a test stack

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

## Step 3 — the dropped products off sale (before step 5)

Hardening 7: plans, boosts, capacity and top-ups have no real-payments path, so they must be off
sale no later than the moment packs cost money. The deploy preflight now enforces it: a deploy with
`PAYMENTS_ENABLE_REAL=true` and this switch not `true` is refused. Do it now, or in the same
redeploy as step 5:

```sh
gh secret set RETIRED_PRODUCTS_OFF_SALE --env production --body true
```

then redeploy. Check: `GET /payer/pricing/catalog` lists credit packs only (no `job_posting`,
`job_boost`, `hiring_capacity`, `quota_topup`, no offer); `POST /payer/capacity` and
`POST /payer/job-postings/<id>/plan` answer 404; an existing posting's stats and
`GET /payer/capacity` still read. Undo: set it to `false` and redeploy (only while
`PAYMENTS_ENABLE_REAL` is off; the preflight refuses the pair otherwise).

## Step 4 — stage the Razorpay **test** keys (nothing changes)

In the Razorpay dashboard, in **Test Mode**: generate an API key (key ID `rzp_test_…` and its key
secret), and add a webhook on `https://<production api host>/payments/razorpay/webhook` for the
`payment.captured` event, with a new webhook secret. These are the same kind of test keys a staging
stack would use; no real money moves on them. Then, `PAYMENTS_ENABLE_REAL` still absent or `false`:

```sh
gh secret set PAYMENTS_PROVIDER_KEY --env production       # rzp_test_…, pasted at the prompt
gh secret set PAYMENTS_PROVIDER_SECRET --env production    # the test key secret, at the prompt
gh secret set RAZORPAY_WEBHOOK_SECRET --env production     # the test webhook secret, at the prompt
```

then redeploy. The deploy passes; read its log for a `::warning::` naming `PAYMENTS_PROVIDER_KEY`
(a malformed key: fix it now, or step 5's deploy is refused). Nothing changes
for anyone: with the flag off the three are inert, and `GET /admin/finance/summary` (admin-web's
finance page) still reports `payments.mode: "mock"` with
`blocked_reason: "PAYMENTS_ENABLE_REAL is false"`.

## Step 5 — the test-key rehearsal: pilot on, real payments on with test keys

Needs step 2 (the staff test company listed), step 3 (products off sale) and step 4 done, and every
prerequisite except "Invoices are live" (the rehearsal moves no money). **If invoices are already
live, the rehearsal's payment takes the next number in the gap-free invoice series**: decide with
the accountant before you start whether that is acceptable or how it is voided.

Set the rollout first and the master gate last, then one redeploy:

```sh
gh secret set CREDIT_CHECKOUT_ROLLOUT --env production --body pilot
gh secret set PAYMENTS_ENABLE_REAL --env production --body true
```

The deploy log shows a `::warning::` that real payments are armed with a TEST key: expected here.
Check `GET /admin/finance/summary` reports `payments.mode: "real"` with `blocked_reason: null`
(`/health` does not report payments). From the first request on the new container: the listed
company can pay through Razorpay's test checkout; its free packs and the ops grant are closed;
**every other company can buy nothing** (both credit routes 404) and the ops grant still works for
it. Keep the window short.

As the staff test company, buy Starter with a Razorpay test card and check what step 7 lists (the
order `paid` with `total_paise = 117900`, one `payment.captured`, one lot of 20 credits, nothing
`held`), then mark the lot `is_test` with step 7's SQL.

If the live keys do not follow straight away, set `PAYMENTS_ENABLE_REAL` back to `false` and
redeploy: that is today's behaviour again (free packs for every company). A capture Razorpay
reports while the flag is off is refused by the webhook (401) until it is back on, so let any
pending test payment settle first.

## Step 6 — the live keys

In the Razorpay dashboard, in **Live Mode**: the live API key (`rzp_live_…` and its key secret) and
a live webhook on the same URL and event with its own new secret. **Delete or disable the Test Mode
webhook** that points at production: its deliveries fail verification from now on.

The three values must change together. If a merge to `main` could land while you swap them, set
`PAYMENTS_ENABLE_REAL` to `false` first (a mixed set, a live key ID with a test secret, passes the
preflight but every order fails at Razorpay). Then:

```sh
gh secret set PAYMENTS_PROVIDER_KEY --env production       # rzp_live_…, pasted at the prompt
gh secret set PAYMENTS_PROVIDER_SECRET --env production    # the live key secret, at the prompt
gh secret set RAZORPAY_WEBHOOK_SECRET --env production     # the live webhook secret, at the prompt
gh secret set CREDIT_CHECKOUT_ROLLOUT --env production --body pilot   # unchanged if still pilot
gh secret set PAYMENTS_ENABLE_REAL --env production --body true       # last
```

then redeploy. The deploy log shows **no** test-key warning. Check `GET /admin/finance/summary`
again (`mode: "real"`, `blocked_reason: null`). The pilot is now taking real money from the listed
company only; every other company still can buy nothing until step 8.

## Step 7 — one staff test purchase, marked `is_test`

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

## Step 8 — everyone

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

- To stop taking money entirely, also set `PAYMENTS_ENABLE_REAL` to `false`
  (`gh secret set PAYMENTS_ENABLE_REAL --env production --body false`, then redeploy). That
  returns production to today: the free mock packs reopen for every company. While it is off the
  webhook refuses every delivery (401), so a capture Razorpay reports after the switch-off settles
  only once it is back on (Razorpay retries for a while). The three Razorpay secrets can stay (they
  are inert while the flag is off) or be removed with `gh secret delete NAME --env production`.
- To stop taking money **and** keep the free packs closed, leave `PAYMENTS_ENABLE_REAL=true` and set
  the rollout to `off`: then no company can buy credits at all.

**What it does not undo:**

- Lots already granted stay, with their expiry, and keep expiring on the sweep.
- Orders stay as they are (`paid`, `held`, `created`). An order created before the rollback still
  settles if Razorpay reports its capture: the webhook is never gated. Its `/verify` answers 404,
  so the credits arrive through the webhook only.
- Invoices, ledger lines and events stay.
- `RETIRED_PRODUCTS_OFF_SALE` is separate: set it to `false` to put the dropped products back on
  sale, but only with `PAYMENTS_ENABLE_REAL` off (the deploy preflight refuses the pair).
- A rotated Razorpay key or webhook secret: change it in the dashboard and in the `production`
  secret together, then redeploy. A webhook secret that does not match makes every delivery 401.

Never roll the code back below #2749 PR 2 while the catalogue row carries `onSaleFrom` or `offered`
(`docs/runbooks/2749-publish-brief-credit-packs.md`).
