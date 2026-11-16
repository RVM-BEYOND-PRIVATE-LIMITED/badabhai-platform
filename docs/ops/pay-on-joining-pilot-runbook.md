# Pay-on-joining pilot — the hire record (runbook note)

Issue #2753 item 11 · API: [`docs/api/admin-pay-on-joining-api-reference.md`](../api/admin-pay-on-joining-api-reference.md) · migration `0168_pay_on_joining_hires`

## What this is, and what it is not

The pilot (3 anchor factories and 5 partners in NCR, December to January) is **run by hand** (brief section 4F). The platform keeps **one record per hire** and nothing else:

- **No invoice.** `invoiced_on` is the date ops raised the invoice outside the platform. Nothing here creates, numbers or sends one.
- **No payout.** `factory_paid_on` and `partner_paid_on` are the dates ops saw the money move. Nothing here pays a partner, holds a balance or lends. The partner is paid when the factory pays, by ops.
- **No eligibility rule.** Which factories are in the pilot is chosen by hand by the owner. No code decides it, and the record does not check it.
- No partner app, payroll or contract staffing.

## The terms the record keeps

- The fee is in integer paise (₹5,000 = `500000`; ₹5,900 with GST = `590000`). The fee itself is whatever was agreed for that hire; for context only, ₹5,000 per operator-level worker (₹5,900 with GST), or half of the first month's salary plus GST for an experienced skilled worker, billed after the worker has stayed 30 days. None of that is coded.
- The partner's share is `POJ_PARTNER_SHARE_PERCENT` (default **70**), copied onto each hire when it is recorded; BadaBhai keeps 30%. The share in paise is floor(fee × percent ÷ 100), computed by the server. Changing the setting affects only hires recorded afterwards.

## Switching it on

1. Apply migration 0168 by hand (its header has the transaction, lock timeout and rollback).
2. Leave `POJ_PARTNER_SHARE_PERCENT` unset for 70, or set it as a `production` environment secret (a whole number 0..100; the deploy refuses anything else).
3. Set `PAY_ON_JOINING_RECORDS_ENABLED=true` as a `production` environment secret and redeploy. Off again: set it `false` and redeploy; the records stay in the table.

## Recording a hire

`POST /admin/pay-on-joining-hires` with the factory, the worker, the joining date and the fee (super admin or ops admin). Add the 30-day check (date and outcome together), the invoice date and the two payment dates with `PATCH …/:id` as they happen. `GET …?paid=partner_due` lists the hires where the factory has paid and the partner has not. Keep phone numbers and emails out of the note (the API refuses them).
