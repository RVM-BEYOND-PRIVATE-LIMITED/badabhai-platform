# Admin API — pay-on-joining hire records (`/admin/pay-on-joining-hires`)

Issue #2753 item 11 · code: `apps/api/src/pay-on-joining/*` · migration `0171_pay_on_joining_hires` · switch `PAY_ON_JOINING_RECORDS_ENABLED` · setting `POJ_PARTNER_SHARE_PERCENT` · runbook: [`docs/ops/pay-on-joining-pilot-runbook.md`](../ops/pay-on-joining-pilot-runbook.md)

The pay-on-joining pilot's record, one row per hire: the factory, the job, the worker, the partner, the joining date, the 30-day check, the fee, the invoice date, the date the factory paid, the partner's share and the date the partner was paid. **A record only.** No route here raises an invoice, moves money, pays a partner, or decides which factory qualifies: the pilot runs by hand (brief section 4F) and the owner chooses its factories.

## Who, and when

|             |                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------- |
| Auth        | admin session (`AdminAuthGuard`) → `PayOnJoiningFlagGuard` → `AdminRolesGuard`, in that order     |
| Capability  | `manage_companies` on all three routes — super_admin, ops_admin (support and analyst `403`)       |
| Switch off  | every route is `404 {"message":"Not found"}` for every role, before any query (no session: `401`) |
| Cache       | `Cache-Control: no-store` on all three (a body can carry the admin's note)                        |
| Idempotency | none: a repeated create is `409` (the unique hire key); a repeated edit changes nothing           |

`manage_companies` is reused, not a new matrix row: a hire record is part of a company's commercial record (the factory and the partner are payers, the fee is what the factory owes). The list shares it rather than the `read_entities` floor because it carries the pilot's commercial terms and the admins' notes.

## Money

- Every amount is **integer paise** (`fee_paise`, `partner_share_paise`), stored as `bigint`, at most `Number.MAX_SAFE_INTEGER`.
- `partner_share_percent` is **copied from `POJ_PARTNER_SHARE_PERCENT` (default 70) when the hire is created** and never changes after, so moving the setting never rewrites a recorded hire.
- `partner_share_paise` is **computed by the server, never accepted**: `floor(fee_paise * partner_share_percent / 100)`, in integer arithmetic. BadaBhai keeps the remainder (the other 30%, plus any fraction of a paisa). An edit that changes the fee recomputes it with the row's **stored** percent. The database holds the same formula (`pay_on_joining_hires_share_math_chk`).
- Worked: a ₹5,000 fee is `500000` paise and its 70% share is `350000`; ₹5,900 with GST is `590000` → `413000`; `500099` → `350069` (350069.3, floored).

## The record

```ts
interface PojHireView {
  id: string;
  factory_payer_id: string; // the factory (a payer id)
  job_posting_id: string | null; // the posting he was hired against, if any
  worker_id: string;
  partner_payer_id: string | null; // the agency partner, if any
  joined_on: string; // YYYY-MM-DD
  stay_checked_on: string | null; // the 30-day check: its date …
  stayed_30_days: boolean | null; // … and its outcome (both, or neither)
  fee_paise: number;
  partner_share_percent: number; // as copied at create
  partner_share_paise: number; // the server's floor
  invoiced_on: string | null;
  factory_paid_on: string | null;
  partner_paid_on: string | null;
  note: string | null; // the admin's own words, ≤ 500 characters
  payment_state: "awaiting_factory" | "partner_due" | "settled";
  created_by_admin_id: string;
  updated_by_admin_id: string;
  created_at: string; // ISO
  updated_at: string;
}
```

Ids only for the factory, the partner, the job and the worker: no admin list decrypts a payer name under this capability (company names are `read_identity`'s, on the Companies screen), so this one does not either.

`payment_state` is derived from the dates, never set: `awaiting_factory` while `factory_paid_on` is empty; `partner_due` once the factory has paid and a partner with a share above zero has no `partner_paid_on`; `settled` otherwise. It reports; it triggers nothing.

## `GET /admin/pay-on-joining-hires`

Query (all optional, `.strict()`): `factory_payer_id` (uuid), `partner_payer_id` (uuid), `paid` (`awaiting_factory` | `partner_due` | `settled`), `cursor` (opaque keyset), `limit` (1–100, default 50).

Newest first on `(created_at, id)`. Answer: `{ items: PojHireView[], nextCursor: string | null }` (the admin entity paging convention).

## `POST /admin/pay-on-joining-hires`

Body (`.strict()`):

| Field                                               | Type                          |                                                                                                   |
| --------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------- |
| `factory_payer_id`                                  | uuid                          | required                                                                                          |
| `worker_id`                                         | uuid                          | required                                                                                          |
| `joined_on`                                         | `YYYY-MM-DD`                  | required, a real calendar day                                                                     |
| `fee_paise`                                         | integer ≥ 0                   | required                                                                                          |
| `job_posting_id`, `partner_payer_id`                | uuid \| null                  | optional                                                                                          |
| `stay_checked_on` + `stayed_30_days`                | date \| null, boolean \| null | optional, both or neither                                                                         |
| `invoiced_on`, `factory_paid_on`, `partner_paid_on` | date \| null                  | optional; `partner_paid_on` needs a partner                                                       |
| `note`                                              | string \| null                | optional, 1–500 characters after trimming; no phone, email, PAN, Aadhaar or other hard identifier |

`partner_share_percent`, `partner_share_paise`, `payment_state` and the admin ids are **not fields**: sending any of them is a `400`. The partner cannot be the factory itself.

Answer `201`: `{ hire: PojHireView, changed: true }`.

## `PATCH /admin/pay-on-joining-hires/:id`

Body (`.strict()`): any of the create fields, at least one. `null` clears a field that can be empty; the factory, the worker, the joining date and the fee cannot be cleared. The rules are judged on the record as it would stand after the edit (the 30-day pair, a partner payment needs a partner, the partner is not the factory). A fee change recomputes the share with the stored percent. Only keys whose value moves count; an edit that moves nothing writes, audits and emits nothing.

Answer `200`: `{ hire: PojHireView, changed: boolean }`.

## Errors

| Status | When                                                                                                                                                                                                                                                                                                                                                                           |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `400`  | a body or query that fails the contract (an unknown key such as `partner_share_paise`, a bad date, a fractional or negative fee, a note with a phone number); a broken rule (the 30-day pair, a partner payment with no partner, partner = factory); an id that names nothing (`"factory_payer_id names no record"`, and likewise for the partner, the posting and the worker) |
| `401`  | no or expired admin session                                                                                                                                                                                                                                                                                                                                                    |
| `403`  | switch on, and a role without `manage_companies` (support, analyst)                                                                                                                                                                                                                                                                                                            |
| `404`  | the switch is off (every route, every role); `PATCH` on an unknown id (`"Hire record not found"`)                                                                                                                                                                                                                                                                              |
| `409`  | the hire is already recorded for this factory, worker and job (no job counts as one value)                                                                                                                                                                                                                                                                                     |

## Audit and events

Each write commits in ONE transaction: the row, an `audit_logs` row (`entity_type` `pay_on_joining_hire`, action `pay_on_joining_hire_created` / `pay_on_joining_hire_updated`, metadata `{ changed_fields }`), `pay_on_joining.recorded` and `admin.action_performed` (target type `pay_on_joining_hire`). Both events have the admin as actor and the factory payer as subject.

`pay_on_joining.recorded` v1 (domain `pay_on_joining`, `.strict()`): `hire_id`, `change` (`created` | `updated`), `changed_fields` (field KEYS: the keys set on create, the keys moved on an edit), `factory_payer_id`, `partner_payer_id`, `job_posting_id`, `worker_id`, `fee_paise`, `partner_share_percent`, `partner_share_paise` (refused unless it is the floor), `stayed_30_days`, `payment_state`. **Never the note text**, and no name or phone anywhere. A failed write's bound parameters are stripped before the error can reach a log.

## Deploy order

1. Apply migration `0171_pay_on_joining_hires` (header: one transaction, `lock_timeout = '3s'`, retry on 55P03), then adopt its ledger row in slot order.
2. Set `POJ_PARTNER_SHARE_PERCENT` only if the pilot's 70 changes (empty means 70).
3. Set `PAY_ON_JOINING_RECORDS_ENABLED=true` as a `production` environment secret and redeploy.
