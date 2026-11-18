# Admin waivers API (`/admin/waivers`)

Issue #2750 items 5 and 12 · code: `apps/api/src/rvm-waivers/*`, `apps/api/src/admin/waivers/*` · migration `<slot>_rvm_applicant_waivers` · switch `CREDIT_RULES_ROLLOUT` (default `off`) · Campus's own door: `PUT` / `GET internal/campus/v1/waivers` ([Campus link v1](campus-link-v1-api-reference.md#put-waivers))

## What a waiver does

Under the credit rules an RVM student who applied costs a company one credit to open. RVM's placement team can waive that:

- **company** waiver: every RVM student who applied to any of that company's jobs opens for 0;
- **job** waiver: the RVM students who applied to that one job open for 0.

Everyone else still pays. A student the company found only by search is not covered. A waived open writes a zero-credit `waived` line on the company's ledger and a use row naming the waiver (`waived_opens`).

## Access

Both routes: `AdminAuthGuard` + `AdminRolesGuard`, capability **`manage_waivers`** (super_admin only). Both answer `404` while `CREDIT_RULES_ROLLOUT` is off everywhere, and `503` with it on and the waiver tables missing.

## `GET /admin/waivers`

Query (strict): `company_id` (uuid, optional), `include_cleared` (`true` / `false`, default `false`), `cursor`, `limit` (1–200, default 50).

`200 { waivers: Waiver[], next_cursor: string | null }`, newest first. An unknown company is an empty page.

```json
{
  "waiver_id": "0b6e2a4c-8d1f-4e3a-9b5c-7d2e1f0a3b4c",
  "scope": "job",
  "company_id": "7d3f2a10-5b8e-4c1d-9a6f-0e2b4c6d8f10",
  "posting_id": "5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
  "active": true,
  "source": "campus",
  "set_by_ref": "7d0f6c1e-2b4a-4c8e-9f10-3a5b6c7d8e9f",
  "set_by_label": "Placement desk, Pune",
  "reason": "Campus drive partner for the November batch",
  "set_at": "2026-11-17T06:30:00.000Z",
  "cleared_at": null,
  "cleared_by_ref": null,
  "cleared_by_label": null,
  "clear_reason": null,
  "waived_opens": 3
}
```

`source` is `campus` (set from Campus) or `admin`. `set_by_label` / `cleared_by_label` are the staff names, stored encrypted and decrypted for this read; `null` when there is none (an admin with no stored name).

## `PUT /admin/waivers`

```json
{ "scope": "company", "company_id": "…", "active": true, "reason_text": "Placement team asked for the November drive" }
```

- `scope` `company` or `job`; a job waiver also sends `posting_id` (that company's posting), a company waiver must not.
- `active: true` sets, `active: false` clears. Idempotent by state: setting an active waiver or clearing a cleared one writes nothing and answers `changed: false`.
- `reason_text`: 15–500 characters, no hard identifiers (the shared admin reason rule).
- The admin is the session's; no body field names one.

`200 { active, changed, waiver: Waiver | null }`. `404` for an unknown or barred company, or a posting that is not that company's.

One transaction holds the waiver row change, an `audit_logs` row (`action = rvm_waiver_changed`, `entity_type = rvm_applicant_waiver`, with the change, scope, ids and the reason) and one `payer.rvm_waiver_set` or `payer.rvm_waiver_cleared` event (actor = the admin; ids and codes only).
