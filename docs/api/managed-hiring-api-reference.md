# Managed Hiring API reference (#2751 items 4 to 13)

A company pays, per job, for BadaBhai's desk to find workers who confirm by phone that they are interested in the job: **at least 5 within 7 working days**, with a **free extension to day 30** when fewer confirm. The service is sourcing and screening. **It never promises a hire**; every response carries the terms line below, and no label, email or notification may promise one.

> Managed Hiring is a sourcing and screening service. BadaBhai does not promise a hire.

Everything is behind `MANAGED_HIRING_ROLLOUT` (key `managed_hiring`, off by default, pilot first). The company routes also need real payments (`PAYMENTS_ENABLE_REAL`). On the mock path the product is not offered at all.

## The rules the server decides

| Job                                                   | Tier        | Before GST | With GST (charged) |
| ----------------------------------------------------- | ----------- | ---------- | ------------------ |
| 1 to 5 vacancies (`1`, `2-5`), fresher to mid level   | `standard`  | ₹4,000     | ₹4,720             |
| 6 to 10 vacancies (`6-10`), **or** an experienced job | `large`     | ₹8,000     | ₹9,440             |
| 11 or more vacancies (`11-25`, `25+`)                 | no checkout | —          | a callback request |

- **Experienced** means `min_experience_years` is 3 or more, or the "Level needed" (`trade_level`) is a rung the trade sheet prices Higher (`priceTierForTradeSkill`, for example setter and above on CNC turning). An unknown trade or rung never prices a job up.
- **Prices** come from the pricing catalogue (`managed_hiring` product; the default catalogue holds the brief's prices). GST comes from `gstPriceLine`, the one GST function. Money in new fields is integer paise.
- **The clock** counts working days, Monday to Saturday, in IST. Sundays are off, as are the dates in the catalogue's `holidays` list, which is empty by the owner's ruling. Day 1 is the first working day **after** the IST day the payment was captured. The deadline is the end of the 7th working day. The free extension ends 30 calendar days after day 1 begins.
- **Target met:** at the deadline, 5 or more confirmations means the order is `met`. Fewer means `extended` at no charge. During the extension, the confirmation that reaches 5 marks the order `met` at once. At the end of the extension, below 5 means `closed_unmet`. An admin is alerted and there is **no automatic refund**.
- **One open order per job:** an order is open while it is `created`, `active` or `extended`.
- **Agency and contractor accounts** (`payers.role = agent`) are refused with a 403 `agency_account`. The product is never in `GET /payer/pricing/catalog` for anyone; the quote serves it.
- **Free contacts:** opening a worker on one of the company's paid trackers costs **0 credits** (cost basis `managed_hiring`). This applies while both `MANAGED_HIRING_ROLLOUT` and `CREDIT_RULES_ROLLOUT` are on for the company, because it is a row of the #2750 cost rule.

## Company routes (`PayerAuthGuard`)

Every route answers the neutral **404** while the switch is off for the company or real payments are off. It answers **503** when the pilot list cannot be read, or when the switch is on and the migration is missing. A refusal is a **409** (or 403) whose body carries a stable `reason`; clients branch on `reason`, never on the message.

### `GET /payer/managed-hiring/quote?job_posting_id=<uuid>`

Returns what Managed Hiring offers for one of the company's own jobs. The job must be live (`open`, not hidden); otherwise the answer is a 409 `job_not_open`. An unknown job, or another company's, is a 404.

```jsonc
// offer: order
{
  "job_posting_id": "uuid",
  "offer": "order",
  "tier": "standard",
  "price": { "price_inr": 4000, "taxable_paise": 400000, "gst_paise": 72000, "round_off_paise": 0, "total_paise": 472000, "gst_rate_bps": 1800 },
  "target_count": 5, "working_days": 7, "extension_days": 30,
  "terms": "Managed Hiring is a sourcing and screening service. BadaBhai does not promise a hire.",
  "open_order": null            // or { "order_id": "uuid", "status": "created" | "active" | "extended" }
}
// offer: callback (11+ vacancies)
{ "job_posting_id": "uuid", "offer": "callback", "vacancy_band": "11-25", "terms": "…", "callback_request_id": null }
```

### `POST /payer/managed-hiring/orders`

Headers: **`Idempotency-Key` is required** (8–200 characters of `A-Z a-z 0-9 . _ : -`). Without it, the answer is a 400 `idempotency_key_required`.

```jsonc
{ "job_posting_id": "uuid", "expected_price_inr": 4000, "origin": "posting_flow" } // origin optional: PAYMENT_ORDER_ORIGINS
```

`201` returns the Razorpay handoff. Open checkout.js with `provider_order_id`, `key_id` and `amount` (paise, GST included):

```jsonc
{
  "order_id": "uuid",
  "provider_order_id": "order_…",
  "key_id": "rzp_…",
  "amount": 472000,
  "amount_inr": 4720,
  "currency": "INR",
  "price": {
    "taxable_paise": 400000,
    "gst_paise": 72000,
    "round_off_paise": 0,
    "total_paise": 472000,
    "gst_rate_bps": 1800,
  },
}
```

- After checkout, call the shared `POST /payer/credits/verify` with the three Razorpay values. The verify response reports `credits: 0` and `pack_code: null` for this order. The webhook settles it too.
- **The order starts only when the payment is captured.** Read `GET /payer/managed-hiring/orders/:id` for the status.
- The same key replays the first handoff and creates no second Razorpay order. The same key with another body is a 422. A duplicate while the first is still running is a 409 `in_flight`.
- If the job already has an **unpaid** order of the same tier, its checkout is handed back.

| Status | `reason`             | When                                                                     |
| ------ | -------------------- | ------------------------------------------------------------------------ |
| 409    | `price_mismatch`     | `expected_price_inr` is not the current list price; nothing is charged   |
| 409    | `above_largest_tier` | 11 or more vacancies; send a callback request instead                    |
| 409    | `order_open`         | the job has an order that is paid and running, or unpaid at another tier |
| 409    | `job_not_open`       | the job is not live                                                      |
| 403    | `agency_account`     | agency or contractor account                                             |

As for a credit pack (#2749 part 4), every payment needs a GST invoice, so the checkout is refused before any order while invoicing is not ready: a **503** `code: "INVOICES_UNAVAILABLE"` while BadaBhai's seller details are not set, and a **409** `code: "BILLING_DETAILS_REQUIRED"` until the company has saved its billing details (`PUT /payer/billing-details`). The invoice is issued when the payment is captured and is listed on `GET /payer/invoices`; its line reads "Managed Hiring — worker sourcing and screening for one job".

### `GET /payer/managed-hiring/orders?job_posting_id=<uuid?>` and `GET /payer/managed-hiring/orders/:id`

```jsonc
{
  "order_id": "uuid", "job_posting_id": "uuid", "tier": "standard",
  "status": "created" | "active" | "met" | "extended" | "closed_unmet" | "cancelled",
  "price_inr": 4000, "target_count": 5, "confirmed_count": 3,
  "started_at": "ISO|null", "due_at": "ISO|null", "extended_until": "ISO|null", "ended_at": "ISO|null",
  "terms": "…",
  "checkout": { /* the handoff above */ } | null,   // only while `created` (unpaid)
  "workers": [ { "worker_id": "uuid", "confirmed_at": "ISO" } ]  // the tracker; never the staff note
}
```

`due_at` is the start of the IST day after the deadline day; show it as "by the end of <that day − 1>". The list route returns `{ "orders": [...] }`, newest first, with at most 50 orders.

### `POST /payer/managed-hiring/callback-requests`

Body: `{ "job_posting_id": "uuid" }`. Only for a job above the largest tier; a job a tier covers gets a 409 `tier_available`. The request is stored once per job and an admin is alerted. Asking again returns the first request.

Response: `200 { "request_id": "uuid", "job_posting_id": "uuid", "created": true | false }`.

## Desk routes (`AdminAuthGuard` + capability `work_managed_hiring`: super_admin, ops_admin, support)

These answer 404 while the switch is off everywhere.

| Route                                                                   |                                                                                                                                                           |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /admin/managed-hiring/orders?status=open\|ended\|all&cursor&limit` | Every company's paid orders. `open` = active or extended; `ended` = met, closed or cancelled; `all` = everything paid. Returns `{ orders, next_cursor }`. |
| `GET /admin/managed-hiring/orders/:id`                                  | One order with `workers: [{ worker_id, confirmed_at, confirmed_by, note }]`.                                                                              |
| `POST /admin/managed-hiring/orders/:id/interest`                        | Body `{ worker_id, note }` (note: 15–500 characters, no phone, email or other hard identifier).                                                           |
| `DELETE /admin/managed-hiring/orders/:id/interest`                      | Body `{ worker_id, reason_text }` (same rule).                                                                                                            |
| `GET /admin/managed-hiring/callback-requests?cursor&limit`              | The callback queue, newest first.                                                                                                                         |

Adding a worker is refused with a 409 and these reasons:

- `order_not_open`: the clock is not running, because the order is unpaid or has ended.
- `already_on_tracker`
- `worker_unavailable`: the worker is unknown, scheduled for deletion, or suspended.
- `no_sharing_consent`: the worker's latest consent does not include `employer_sharing`.
- `rvm_student_not_applied`: an actively linked RVM student can be added only if he applied to this job.

Each change writes an `audit_logs` row (entity `managed_hiring_order`; the note or reason lives there) and an event in the same transaction. The desk calls the worker through the existing reason-gated reveal.

## Events (ids, codes, integers and times only; never the staff note)

| Event                                                              | Notes                                                       |
| ------------------------------------------------------------------ | ----------------------------------------------------------- |
| `managed_hiring.order_created`                                     |                                                             |
| `managed_hiring.order_activated`                                   | On capture, in the settle transaction.                      |
| `managed_hiring.order_extended`                                    |                                                             |
| `managed_hiring.order_met`                                         | `met_at`: `deadline` or `extension`.                        |
| `managed_hiring.order_closed_unmet`                                | **Admin alert**: counted on the dashboard's breach counter. |
| `managed_hiring.interest_added`, `managed_hiring.interest_removed` |                                                             |
| `managed_hiring.callback_requested`                                | **Admin alert**: counted on the dashboard's breach counter. |

The company is emailed at each change (started, met, extended, closed), as best effort. A phone-only login gets no email; the status still shows on the order route.
