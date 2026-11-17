# Runbook: switch on real credit payments, pilot first (#2749 item 10)

**Who:** Prakash (production secrets, the Razorpay account, the SQL editor), with Divyanshu for the
checks. **Not** a normal deploy step. Decided in ADR-0065 §3.6; the switches are described in
`docs/environment-variables.md`.

D5 and D15: pilot first, no staging, and nothing is switched off by the issue itself. Every step
below is an owner act.

## What production runs today

| Switch                      | Value            | What it means                                                                                                                                        |
| --------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PAYMENTS_ENABLE_REAL`      | absent = `false` | Real checkout (`POST /payer/credits/order`, `/verify`) answers 404 for everyone; the Razorpay webhook answers 401.                                   |
| The three Razorpay secrets  | absent           | `PAYMENTS_PROVIDER_KEY`, `PAYMENTS_PROVIDER_SECRET`, `RAZORPAY_WEBHOOK_SECRET`: bridged since part 5b, inert while `PAYMENTS_ENABLE_REAL` is off.    |
| `CREDIT_CHECKOUT_ROLLOUT`   | absent = `off`   | The new money rules apply to no company: free mock packs (`POST /payer/credits`) and the ops grant (`POST /payers/:payerId/credits`) work as before. |
| `RETIRED_PRODUCTS_OFF_SALE` | absent = `false` | Posting plans, boosts, capacity, top-ups, offers and coupons are still on sale (mock-paid).                                                          |

Deploying part 5a (the two switches) or part 5b (the payment bridge) changes none of it.

## The gates, once switched (ADR-0065 §3.6)

"Real payments live" means `PAYMENTS_ENABLE_REAL=true` **and** all three Razorpay secrets set
(`areRealPaymentsEnabled`).

| Route                                                | Company in the rules (`on`, or `pilot` and listed)                                                                                                       | Company not in the rules                                                | Pilot list unreadable                           |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------- |
| New order (`POST /payer/credits/order`)              | open while real payments are live; 404 otherwise                                                                                                         | 404                                                                     | 404                                             |
| Verify (`POST /payer/credits/verify`)                | open while real payments are live; 404 otherwise                                                                                                         | the same: the rollout does not gate a verify                            | the same                                        |
| Free mock packs (`POST /payer/credits`)              | 404                                                                                                                                                      | open while real payments are off; 404 while live                        | 404                                             |
| Ops grant (`POST /payers/:payerId/credits`)          | 409 (`real_payments_live` or `credit_checkout_rollout`)                                                                                                  | grants while real payments are off; 409 `real_payments_live` while live | 503 while real payments are off; 409 while live |
| `GET /payer/credits` → `checkout`                    | `real` while real payments are live; else `none`                                                                                                         | `free` while real payments are off; else `none`                         | `none`                                          |
| Razorpay webhook (`POST /payments/razorpay/webhook`) | not gated by the rollout. It verifies the signature with `RAZORPAY_WEBHOOK_SECRET`, so it answers 401 to EVERY delivery while real payments are not live | the same                                                                | the same                                        |

**While real payments are live, a company outside the rollout can buy nothing** (both credit
routes answer 404). It keeps its balance, and posting, search and applicants stay free. Keep the
pilot short.

**Front ends read `checkout` from `GET /payer/credits`** (`real` | `free` | `none`) to decide which
buy button to show, never their own copy of `PAYMENTS_ENABLE_REAL`: it is computed from the same
gates the routes apply, for the caller's company.

**Not gated by this switch** (ADR-0065 §3.6): the signup free-tier grant and the admin grant. See
the prerequisites before step 6.

## Before anything: prerequisites

Do not start step 4 until every box in this section is ticked. One exception: steps 4a and 4b move
no money and may go ahead of "Invoices are live" (4b says what that costs).

- [ ] **The Razorpay secrets reach the container: done by #2749 part 5b**, once it is merged and
      deployed. It bridges `PAYMENTS_ENABLE_REAL`, `PAYMENTS_PROVIDER_KEY`,
      `PAYMENTS_PROVIDER_SECRET` and `RAZORPAY_WEBHOOK_SECRET` from the GitHub `production`
      environment secrets of the same names (`ci.yml` `env:` + `envs:`; compose
      `${PAYMENTS_ENABLE_REAL:-false}` on `api` and `payer-web`, `${NAME:-}` for the three on `api`
      only), makes the three Razorpay fields `optionalSecret()` so an absent secret boots as today,
      and adds the deploy preflight below. With the secrets absent it changes nothing.
- [ ] **The Razorpay account captures automatically** (Razorpay dashboard → payment capture
      settings). The browser verify settles a payment only once Razorpay reports it `captured`; an
      `authorized` payment is left for the webhook's `payment.captured`. With manual capture no
      payment would ever settle.
- [ ] **Invoices are live** (#2749 part 4): merged, its migration applied, the seller row filled.
      Every payment needs a GST invoice.
- [ ] **payer-web is ready** (Rishi): the purchase confirmation shows the pack's `price.display`
      (`₹999 plus GST (₹1,179)`) before Razorpay opens (BB-R-03); it shows no per-unlock price and
      no value framing (#2744, PR #2792); it shows the buy button from `GET /payer/credits`'s
      `checkout`; the plan, boost, capacity and top-up buttons are gone or hidden, because they
      answer 404 once `RETIRED_PRODUCTS_OFF_SALE` is on; and it copes with a catalogue that lists
      no product at all (below).
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
- [ ] **Two hardening items the owner accepts for the PILOT, in writing on #2749** (both become
      prerequisites before step 6, below):
  - **Hardening 6 — no webhook inbox and no reconciliation job** (#2773). A delivery that fails
    for good (Razorpay stops retrying) leaves a paid order `created`, and nothing notices. Accepted
    for the pilot only because it is one staff company at low volume, and because of this daily
    check, done by hand against the Razorpay dashboard until #2773 runs nightly:

    ```sql
    SELECT id, provider_order_id, pack_code, total_paise, status, created_at
    FROM payment_orders
    WHERE status IN ('created', 'failed') AND created_at < now() - interval '15 minutes'
    ORDER BY created_at;
    ```

    Look each row up in the Razorpay dashboard. A row created before step 4c is a rehearsal order:
    look it up in **Test Mode**; it carries no money. Not paid: leave it. Captured: it must be settled
    while real payments are live (a webhook redelivery, or the buyer's `/verify` again); if that
    cannot happen, refund it in the dashboard.

  - **Hardening 11 — catalogue edits ride the shared ops token.** `PUT /pricing/catalog` sits
    behind `InternalServiceGuard`, the one token many ops controllers share, so any holder can
    re-price or re-size a pack once real money follows the catalogue; `updated_by` is whatever
    the caller sends. Accepted for the pilot only with this mitigation: watch every
    `pricing.changed` event (field names only) and compare `GET /pricing/catalog`'s `revision`
    before and after each pilot purchase.

### Before step 6 (everyone), in addition

- [ ] **The signup grant is cut or replaced** (#2750, B4C-11; built in another session).
      `FreeTierService.grantForPayer` gives every new company `match_config.freeUnlockCredits`
      (default 50) as a `legacy` lot that never expires: at the brief's prices about ₹2,500 per
      account, and it makes the open free-credit phone-harvest audit finding worth money. This
      switch does not gate it. It is also live during the pilot (every new company outside the
      pilot gets it); keep the pilot short or cut it earlier.
- [ ] **The admin grant is understood.** `POST /admin/payers/:id/credits` is not gated by this
      switch: `AdminAuthGuard`, the `grant_credits` capability, a reason code, at most 10,000
      credits per grant, one `admin.action_performed` (`credits_granted`) event in the same
      transaction. Its per-company cap comes with #2750's goodwill path.
- [ ] **Hardening 6 and 11** are fixed (#2773 nightly reconciliation; catalogue edits behind the
      admin sign-in with an audit row), or the owner accepts each again, in writing, for everyone.

## How the payment secrets are set (read before steps 3 and 4)

**Every deploy reads the secrets as they stand when it runs**: a teammate's merge to `main`, or a
re-run. So set them in the order step 4 gives, where every state in between is safe, with
`PAYMENTS_ENABLE_REAL` **last**.

- **Values never go on a command line, in chat, in an issue or in a log.** For the three Razorpay
  values run `gh secret set NAME --env production` with no `--body` and paste the value at the
  prompt. Only the switches (`true`, `false`, `pilot`, `on`, `off`) take `--body`.
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
- `PAYMENTS_ENABLE_REAL` is `true` and `RETIRED_PRODUCTS_OFF_SALE` is not on (`true` or `1`)
  (hardening 7);
- `PAYMENTS_ENABLE_REAL` is `true` and `PAYMENTS_PROVIDER_KEY` is not the key ID alone,
  `rzp_test_` or `rzp_live_` then letters and digits only (most likely the key secret pasted into
  the key slot, or a `key-id:key-secret` pair). With the flag
  not `true` the same key only prints a `::warning::` naming `PAYMENTS_PROVIDER_KEY` and the deploy
  goes on, so a bad paste never blocks unrelated deploys, but it does block arming: fix it as soon
  as the warning appears;
- `PAYMENTS_ENABLE_REAL` is `1` (the api reads it as on, payer-web only reads `true`): use `true`.

A refused deploy leaves production exactly as it was, but every later deploy is refused too until
the secret is fixed, so fix it straight away. Armed with a `rzp_test_` key the deploy passes with a
`::warning::`: **`rzp_live_` is what production expects; `rzp_test_` is for the rehearsal in step
4b only.**

## Step 1 — the route logic with test keys, on a test stack

A local or test stack with its own database (there is no staging). Set `PAYMENTS_ENABLE_REAL=true`,
the `rzp_test_*` key, its secret and a webhook secret, `CREDIT_CHECKOUT_ROLLOUT=pilot`, and list
one test company (step 2's SQL against the test database). Then:

1. As the listed company: `GET /payer/credits` says `checkout: "real"`; `GET /payer/pricing/catalog`
   shows the brief's packs with their GST lines; `POST /payer/credits/order` with an
   `Idempotency-Key` returns `amount: 117900` for Starter; pay in test checkout; the webhook settles
   once (one ledger line, one lot of 20 credits expiring 30 days later); a replayed webhook adds
   nothing; `/verify` reports the same balance.
2. As the listed company: `POST /payer/credits` → 404. The ops grant → 409 `real_payments_live`.
3. As a company **not** listed: `GET /payer/credits` says `checkout: "none"`;
   `POST /payer/credits/order` → 404, `POST /payer/credits` → 404 (real payments live), the ops
   grant → 409 `real_payments_live`.
4. A capture of the wrong amount moves the order to `held` and grants nothing (`payment.held`). A
   verify of an `authorized` (not yet captured) payment grants nothing.
5. Rollback drill: create an order, pay it, but block the webhook; set
   `CREDIT_CHECKOUT_ROLLOUT=off`. A new order answers 404, `/verify` of the paid order still
   settles it, and the lot is there with its expiry.

## Step 2 — list the pilot company (production SQL)

Adding the row changes nothing while the switch is `off`. In the BadaBhai SQL editor:

```sql
BEGIN;
INSERT INTO feature_pilot_payers (feature, payer_id, added_by, reason) VALUES
  ('credit_checkout', '<tenant key>', 'owner_sql', '#2749 pilot: staff test company')
ON CONFLICT (feature, payer_id) DO NOTHING;
COMMIT;
SELECT feature, payer_id, added_by, reason, created_at
FROM feature_pilot_payers WHERE feature = 'credit_checkout' ORDER BY created_at;
```

`added_by` is a fixed token, never a person's name (`fpp_added_by_chk`). `<tenant key>`: with
`PAYER_ORG_TENANCY_MODE=on` it is the company's anchor `payers.id`, and every team member inherits
the place; in `off` / `shadow` it is the login itself, so list each login that should buy. The list
is read on every request; a row added or deleted counts from the next one.

## Step 3 — the dropped products off sale (no later than step 4b)

Hardening 7: plans, boosts, capacity and top-ups have no real-payments path, so they must be off
sale no later than the moment packs cost money. The deploy preflight enforces it: a deploy with
`PAYMENTS_ENABLE_REAL=true` and this switch not `true` is refused. Do it now, or in the same
redeploy as step 4b:

```sh
gh secret set RETIRED_PRODUCTS_OFF_SALE --env production --body true
```

then redeploy. Check: `GET /payer/pricing/catalog` lists credit packs only (no `job_posting`,
`job_boost`, `hiring_capacity`, `quota_topup`, no offer); `POST /payer/capacity` and
`POST /payer/job-postings/<id>/plan` answer 404; an existing posting's stats and
`GET /payer/capacity` still read. Undo: set it to `false` and redeploy (only while
`PAYMENTS_ENABLE_REAL` is off; the preflight refuses the pair otherwise).

**For Rishi (payer-web):** with this switch on and no credit pack on sale (a stored catalogue row
that failed validation, or every pack held back), `GET /payer/pricing/catalog` returns
`products: []`. payer-web's `live-catalog.ts` parses `products` with `.min(1)` and on a parse
failure falls back to its built-in `DEFAULT_CATALOG`, which shows the retired plans and boosts
again (display only; the server refuses every purchase). payer-web must accept an empty product
list and show "no packs on sale".

## Step 4 — pilot on, real payments on: test keys first, then live keys

Read "How the payment secrets are set" above first. Three parts, in this order. Never paste a
secret value into a command line, an issue or a log.

**The Razorpay webhook, in each mode:** URL `POST /payments/razorpay/webhook` on the api's public
host, its own new secret (the one you then store as `RAZORPAY_WEBHOOK_SECRET`), subscribed exactly
to **`payment.captured`** and **`payment.failed`** (the two events the api acts on; any other is
answered 200 and ignored). Test Mode and Live Mode each have their own API key, webhook and
capture setting: set capture to automatic in both.

### 4a — stage the Razorpay test keys (nothing changes)

In the Razorpay dashboard, in **Test Mode**: automatic capture, an API key (key ID `rzp_test_…` and
its key secret) and the webhook above. These are the same kind of keys a staging stack would use;
no real money moves on them. Then, with `PAYMENTS_ENABLE_REAL` still absent or `false`:

```sh
gh secret set PAYMENTS_PROVIDER_KEY --env production       # rzp_test_…, pasted at the prompt
gh secret set PAYMENTS_PROVIDER_SECRET --env production    # the test key secret, at the prompt
gh secret set RAZORPAY_WEBHOOK_SECRET --env production     # the test webhook secret, at the prompt
```

then redeploy. The deploy passes; read its log for a `::warning::` naming `PAYMENTS_PROVIDER_KEY`
(a malformed key: fix it now, or 4b's deploy is refused). Nothing changes for anyone: with the flag
off the three are inert, and `GET /admin/finance/summary` (admin-web's finance page) still reports
`payments.mode: "mock"` with `blocked_reason: "PAYMENTS_ENABLE_REAL is false"`.

### 4b — the test-key rehearsal: pilot on, real payments on, test keys

Needs steps 2 and 3 and every prerequisite above except "Invoices are live" (the rehearsal moves no
money). **If invoices are already live, the rehearsal's payment takes the next number in the
gap-free invoice series**: decide with the accountant beforehand whether that is acceptable or how
it is voided.

Set the rollout first and the master gate last, then one redeploy:

```sh
gh secret set CREDIT_CHECKOUT_ROLLOUT --env production --body pilot
gh secret set PAYMENTS_ENABLE_REAL --env production --body true
```

The deploy log shows a `::warning::` that real payments are armed with a TEST key: expected here.
Check that `GET /admin/finance/summary` reports `payments.mode: "real"` with
`blocked_reason: null`; `/health` does not report payments.

From the first request on the new container, exactly as for the live pilot (so keep the window
short): the listed company can pay through Razorpay's test checkout (`checkout: "real"`), and its
free packs and the ops grant are closed; every other company can buy nothing (both credit routes
404, `checkout: "none"`), and the ops grant refuses everyone (`real_payments_live`).

As the staff test company, buy Starter with a Razorpay test card and run step 5's checks (the order
`paid` with `total_paise = 117900`, one `payment.captured`, one lot of 20 credits, nothing `held`),
then mark the lot `is_test` with step 5's SQL.

If the live keys do not follow straight away, do **not** set `PAYMENTS_ENABLE_REAL` to `false` on
its own: follow "Rollback" below (the rollout `off`, the open orders reconciled, then the flag).

### 4c — the live keys

In the Razorpay dashboard, in **Live Mode**: automatic capture, the live API key (`rzp_live_…` and
its key secret) and the webhook above, with a new secret. Then:

1. Stop new orders while the keys change, so no order is ever created on a mixed set (a live key ID
   with a test secret passes the preflight, but Razorpay refuses the order):

   ```sh
   gh secret set CREDIT_CHECKOUT_ROLLOUT --env production --body off
   ```

   then redeploy, and allow open test checkouts to finish (at least an hour). Real payments stay
   on, so no company can buy credits meanwhile. Test orders carry no money; one left `created` can
   stay, but it keeps appearing in the daily check and in the Rollback list: anything created
   before this step is looked up in Test Mode, not Live Mode.

2. Swap all three:

   ```sh
   gh secret set PAYMENTS_PROVIDER_KEY --env production       # rzp_live_…, pasted at the prompt
   gh secret set PAYMENTS_PROVIDER_SECRET --env production    # the live key secret, at the prompt
   gh secret set RAZORPAY_WEBHOOK_SECRET --env production     # the live webhook secret, at the prompt
   ```

3. Open the pilot again, then redeploy:

   ```sh
   gh secret set CREDIT_CHECKOUT_ROLLOUT --env production --body pilot
   ```

   The deploy log shows **no** test-key warning. Check `GET /admin/finance/summary` again
   (`payments.mode: "real"`, `blocked_reason: null`).

4. **Delete or disable the Test Mode webhook** that points at production: its deliveries now fail
   verification (401).

From the first request on the new container the pilot takes real money from the listed company,
with the same gates as 4b; step 5 proves it.

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

When the pilot is proved **and the "Before step 6" boxes are ticked**:

```sh
gh secret set CREDIT_CHECKOUT_ROLLOUT --env production --body on
```

then redeploy. Every company: real checkout open (`checkout: "real"`), free mock packs closed;
the ops grant refuses everyone; credit grants go through the goodwill path (#2750). The pilot rows
can stay.

## Rollback: stop SELLING, keep SETTLING

**The only way to stop sales is the rollout back to `off`, with `PAYMENTS_ENABLE_REAL` left ON:**

```sh
gh secret set CREDIT_CHECKOUT_ROLLOUT --env production --body off
```

then redeploy (or, for one company, delete its `feature_pilot_payers` row: no redeploy). No code
change, no migration.

**What it does:** `POST /payer/credits/order` answers 404 for every company (no new order, no new
money). Everything that settles money already taken keeps working: the webhook still verifies and
settles, and `/verify` still settles a paid order (it is gated on real payments only). Because
real payments stay live, the free mock packs stay closed and the ops grant keeps refusing:
**no company can buy credits at all** until the switch goes back on.

**Do NOT set `PAYMENTS_ENABLE_REAL=false` as a rollback.** It removes the credentials the webhook
verifies with: every Razorpay delivery is then answered 401, and `/verify` answers 404. A buyer who
paid minutes earlier is charged and gets no credits; Razorpay retries a failed delivery only for a
limited time. It also reopens the free mock packs for every company.

Turn real payments off only after every open order is reconciled:

1. Set the rollout to `off` (above) and wait until checkouts already open have finished (Razorpay
   checkout sessions expire; allow at least an hour).
2. List the orders that could still be paid:

   ```sql
   SELECT id, provider_order_id, pack_code, total_paise, status, created_at
   FROM payment_orders
   WHERE status IN ('created', 'failed')
   ORDER BY created_at;
   ```

   (`failed` is listed too: Razorpay lets a buyer retry on the same order, and a later capture
   still settles it.)

3. For each, look the order up in the Razorpay dashboard (Test Mode for one created before step
   4c). Not paid: nothing to do. Captured: settle
   it while real payments are still live (a webhook redelivery, or the buyer's `/verify`), or
   refund it in the dashboard.
4. Only when the list holds no captured payment: `gh secret set PAYMENTS_ENABLE_REAL --env
production --body false`, then redeploy. From then on the free mock packs reopen for every
   company (production as before #2749), unless `CREDIT_CHECKOUT_ROLLOUT` is `on`.

**What a rollback does not undo:**

- Lots already granted stay, with their expiry, and keep expiring on the sweep.
- Orders stay as they are (`paid`, `held`, `created`, `failed`).
- Invoices, ledger lines and events stay.
- `RETIRED_PRODUCTS_OFF_SALE` is separate: set it to `false` to put the dropped products back on
  sale, but only once `PAYMENTS_ENABLE_REAL` is off (the deploy preflight refuses the pair).
- The three Razorpay secrets stay. With `PAYMENTS_ENABLE_REAL` off they are inert; remove them, if
  wanted, with `gh secret delete NAME --env production`.
- A rotated Razorpay key or webhook secret follows 4c's order. The webhook guard holds one secret,
  so from the dashboard change until the redeploy lands every delivery gets 401:
  1. the rollout `off` (`PAYMENTS_ENABLE_REAL` stays on) and a redeploy, then wait for open
     checkouts to finish;
  2. change it in the dashboard and in the `production` secret together;
  3. redeploy, and confirm the deploy succeeded (a refused deploy, or a red `main`, leaves the old
     secret serving and the 401s going on);
  4. run the daily check above: any captured order still `created` is settled by a webhook
     redelivery or the buyer's `/verify`;
  5. only then the rollout back to `pilot` or `on`.

Never roll the code back below #2749 PR 2 while the catalogue row carries `onSaleFrom` or `offered`
(`docs/runbooks/2749-publish-brief-credit-packs.md`).

## Notes for the front ends

- **payer-web (Rishi):** use `GET /payer/credits`'s `checkout` for the buy button; handle an empty
  `products` list (step 3); hide the retired products' buttons before step 3.
- **The ops console (`apps/web`):** its credits top-up calls the ops grant and shows any refusal as
  "Top-up failed (unknown pack…)". From step 4b every top-up is a 409 (`real_payments_live`, or
  `credit_checkout_rollout` for a pilot company while real payments are off); it needs its own
  message for those. `apps/web` is owned by Prakash (`.github/CODEOWNERS`), not Rishi, so this is
  a backend/ops follow-up, listed here and not built in this PR.
