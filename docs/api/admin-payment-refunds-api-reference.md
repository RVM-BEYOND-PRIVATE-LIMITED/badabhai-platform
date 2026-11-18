# Admin refunds (`/admin/payment-orders/:id/refund`, `/admin/payment-refunds/*`)

Issue #2750 items 10 and 12 · code: `apps/api/src/payment-refunds/*`, `apps/api/src/admin/payment-refunds/*` · table `payment_refunds` (migration `0186`) · settings `refundUnusedWithinDays` (7), `refundLowMatchWithinDays` (30), `refundLowMatchMinWorkers` (3) in `credit_rules_config` · ADR-0066 §2.11

Capability `refund_payments` (super_admin only; owner ruling 2026-11-18). The admin is the session's. Companies have no refund route.

## Off until credit notes exist

Every route below answers **503 `CREDIT_NOTES_UNAVAILABLE`** until GST credit notes can be issued (owner ruling 2026-11-18). Invoices and credit notes are #2749 part 4, and they wait on the seller's GSTIN. Every route also answers 503 `REAL_PAYMENTS_OFF` while real payments are off.

## The rules

A refund is always **full**: the order's whole total, GST included. The pack must be **unused**: nothing spent from its lot, and the lot not expired.

| Rule | When | Counts from |
|---|---|---|
| `unused` | within `refundUnusedWithinDays` (7) days | the purchase (the settle that granted the credits) |
| `low_match` | within `refundLowMatchWithinDays` (30) days, and the job drew **fewer than** `refundLowMatchMinWorkers` (3) applicants | the purchase. The job is the one the order was bought from, or one the admin names (it must be the company's) |

"Applicants" are the people who applied to that job (owner ruling 2026-11-18). Any real paid order can be refunded, pilot company or not.

## `GET /admin/payment-orders/:id/refund-eligibility?job_posting_id=`

```json
{
  "payment_order_id": "…",
  "payer_id": "…",
  "amount_paise": 117900,
  "credits": 20,
  "purchased_at": "2026-11-16T09:00:00.000Z",
  "pack_unused": true,
  "refund": null,
  "rules": {
    "unused": { "eligible": true, "until": "2026-11-23T09:00:00.000Z", "refusal": null },
    "low_match": {
      "eligible": false, "until": "2026-12-16T09:00:00.000Z", "refusal": "too_many_applicants",
      "job_posting_id": "…", "applicants": 4, "needs_fewer_than": 3
    }
  }
}
```

`refusal` is one of `pack_used`, `window_passed`, `no_job` or `too_many_applicants`. `refund` is the existing refund, when there is one. 404 for an order that is not a real paid credit-pack order.

## `POST /admin/payment-orders/:id/refund`

```json
{ "rule": "unused", "reason_text": "Company bought the wrong pack by mistake", "job_posting_id": null }
```

- `reason_text`: the shared admin reason rule (15–500 characters, no phone numbers or other hard identifiers). It is stored on the `audit_logs` row only.
- `job_posting_id`: optional, for `low_match` only.

**What happens, in order:**
1. One transaction:
   - locks the order and checks the rule;
   - takes the pack's credits back, plus any credits that came back with it (#2750 item 9), with one `pack_refund` ledger line per lot (key `pack_refund:<lot id>`);
   - writes the `payment_refunds` row (`requested`), the audit row and `payment.refund_requested`.
2. Razorpay is asked to refund the total. A refund it already made for this row (found by our row id in its notes) is adopted, never made twice.
3. The row moves to `pending` (`processed` when Razorpay says so at once), or `failed` (`provider_error`) when the call fails. The credits stay removed either way.

200 with the refund (below).

| Status | `code` | When |
|---|---|---|
| 404 | — | no such order; not a real paid credit-pack order; a `job_posting_id` that is not the company's |
| 409 | `ALREADY_REFUNDED` | the order has a refund (one per order, ever) |
| 409 | `REFUND_RULE_NOT_MET` | the rule does not hold; the body has `rule` and `refusal` |
| 503 | `CREDIT_NOTES_UNAVAILABLE` / `REAL_PAYMENTS_OFF` | see above |

## `GET /admin/payment-refunds/:id`

```json
{
  "id": "…", "payment_order_id": "…", "payer_id": "…", "rule": "unused",
  "job_posting_id": null, "applicants_counted": null, "requested_by": "…",
  "amount_paise": 117900, "credits_removed": 23,
  "status": "pending", "failure_code": null, "provider_refund_id": "rfnd_…",
  "credit_note_number": null,
  "requested_at": "…", "processed_at": null
}
```

`status`: `requested` → `pending` → `processed`, or `failed` (`failure_code`: `provider_error` when the call failed, `provider_failed` when Razorpay failed the refund).

## `POST /admin/payment-refunds/:id/retry`

`{ "reason_text": "…" }`. This sends a `failed` refund to Razorpay again. It also re-sends a `requested` one older than ten minutes, whose provider call was lost. Anything else gets 409 `REFUND_NOT_RETRYABLE`. The retry is audited (`payment_refund_retried`).

## Webhooks

`POST /payments/razorpay/webhook` with `refund.created`, `refund.processed` or `refund.failed` moves the refund. The refund is found by its `rfnd_*` id, or by our row id in its notes. `processed` is final. A refund this code did not make, such as one from the dashboard, is acknowledged and ignored. Each move records `payment.refund_status_changed`. While credit notes are unavailable, no refund of ours can exist, so every refund delivery is acknowledged without reading the table.

## Events

- `payment.refund_requested` `{refund_id, payment_order_id, payer_id, rule, amount_paise, credits_removed}` (actor: the admin).
- `payment.refund_status_changed` `{refund_id, payment_order_id, payer_id, status, failure_code}`.
