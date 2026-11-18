# Posting choice (`GET /payer/job-postings/posting-options`, the publish's `posting_choice`)

Issue #2751 items 1 to 3 · code: `apps/api/src/posting-choice/*`, `JobPostingsService.updateForPayer` · table `job_posting_choices` (migration `0187`) · event `job_posting.posting_choice_recorded` · switch `POSTING_CHOICE_ROLLOUT` (`posting_choice`)

A company publishes a job with one of two buttons, **"Post free"** or **"Post free + Starter"** (brief 4B.7). The job goes live either way, and whatever happens to the payment. The server decides every text; clients display.

## The switch

`POSTING_CHOICE_ROLLOUT`: `off` (default) | `pilot` (companies listed for `posting_choice` in `feature_pilot_payers`) | `on`. Off for the company:

- `GET /payer/job-postings/posting-options` answers the house neutral **404**;
- the publish ignores `posting_choice` / `surface` (the shape is still checked) and its answer has no `posting_choice` block;
- `job_posting_choices` is never read or written.

Apply migration `0187` before setting it to `pilot` or `on`.

## `GET /payer/job-postings/posting-options`

Employer accounts only (an agency gets the `PayerRoleGuard` **403**; it posts no company jobs). Declared before `GET /payer/job-postings/:id`.

```json
{
  "free": {
    "choice": "free",
    "offered": true,
    "label": "Post free (5 contacts)",
    "welcome_credits": 5
  },
  "free_plus_pack": {
    "choice": "free_plus_pack",
    "offered": true,
    "label": "Post free + Starter ₹999 (20 contacts)",
    "pack": { "code": "pack_starter", "price_inr": 999, "total_paise": 117900, "credits": 20 },
    "checkout_origin": "posting_flow"
  }
}
```

**Free button.** Counts the welcome credits (`welcomeCredits` in the credit rules, #2750 item 4) only while the `credit_rules` switch is on for the company and it has **never been given them** (owner ruling 2026-11-18, "count until granted"). Otherwise `"label": "Post free"`, `"welcome_credits": null`. A read failure also gives `"Post free"`: the label never promises what may not come.

**Paid button.** Offers `pack_starter` only (owner ruling 2026-11-18), priced from the live catalogue: `price_inr` is the list price before GST (what the label shows and `expected_price_inr` confirms), `total_paise` the GST-inclusive total the checkout charges. `offered: false`, `label: null`, `pack: null` when:

- real payments are not live (`PAYMENTS_ENABLE_REAL` off or a Razorpay secret missing): the purchase routes are then a mock that takes no money, and a paid button must never lead there;
- `pack_starter` is not on sale in the live catalogue (production before the #2749 go-live publish, `docs/runbooks/2749-publish-brief-credit-packs.md`). No other pack stands in;
- the catalogue cannot be read.

A client shows both buttons at equal size when `free_plus_pack.offered` is true, and the free button alone otherwise.

## The publish: `PATCH /payer/job-postings/:id`

Additive body fields, **both or neither**, and **only with `"status": "open"`** (400 otherwise):

| Field | Values |
|---|---|
| `posting_choice` | `free` \| `free_plus_pack` |
| `surface` | `web` \| `app` |

```json
{ "status": "open", "posting_choice": "free_plus_pack", "surface": "web" }
```

The publish runs exactly as before. **After it committed**, with the switch on, the choice is stored once per posting (the posting id is the primary key; a later record changes nothing) with one `job_posting.posting_choice_recorded` event in the same transaction. Nothing here can fail the publish: an error is logged (ids and the SQLSTATE) and the answer says `recorded: false`.

Additive answer block (present only when the switch is on and the body carried a choice on a draft → open publish):

```json
{
  "id": "…",
  "status": "open",
  "posting_choice": {
    "choice": "free_plus_pack",
    "surface": "web",
    "recorded": true,
    "checkout": {
      "pack_code": "pack_starter",
      "expected_price_inr": 999,
      "origin": "posting_flow",
      "origin_job_posting_id": "…"
    }
  }
}
```

`checkout` is non-null only for `free_plus_pack` while the paid button is offered.

## The checkout from the paid button (item 3)

The client sends `checkout` as the body of `POST /payer/credits/order` (#2749, with a fresh `Idempotency-Key`). The order stores `payment_orders.origin = 'posting_flow'` and `origin_job_posting_id` = the job (only when the job is the company's own; any other id is dropped silently). A failed or abandoned payment leaves the job live.

## Counting the share per button

```sql
SELECT date_trunc('week', c.recorded_at AT TIME ZONE 'Asia/Kolkata') AS week,
       jp.city, jp.role_kind, c.choice, count(*)
  FROM job_posting_choices c
  JOIN job_postings jp ON jp.id = c.job_posting_id
 GROUP BY 1, 2, 3, 4;
```

Joined to purchases: `LEFT JOIN payment_orders po ON po.origin_job_posting_id = c.job_posting_id AND po.status = 'paid'`.

## Event

`job_posting.posting_choice_recorded` v1, subject `job_posting`, actor the acting login: `{ job_posting_id, choice, surface }`. Ids and enums only. Idempotency key `job_posting.posting_choice_recorded:<posting id>`.
