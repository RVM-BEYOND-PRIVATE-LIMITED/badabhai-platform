# Admin worker desk API (`/admin/desk/reach-cases`)

Issue #2750 items 7 and 12 · code: `apps/api/src/reach-desk/*`, `apps/api/src/admin/reach-desk/*` · migration `<slot>_contact_reach_cases` · switch `CREDIT_RULES_ROLLOUT` (default `off`) · the company's side: `POST /payer/unlocks/:unlockId/couldnt-reach` ([payer reference](payer-agency-api-reference.md))

## What the desk does

A company under the credit rules that opened a contact and could not reach the worker reports it, up to day `couldntReachWindowDays` (7, IST calendar days) after the open. That opens one case per open, due `deskWindowHours` (48) later. The desk calls the worker and closes the case:

| Outcome | Credits back |
| --- | --- |
| `reached_interested` | none |
| `reached_declined` | none |
| `not_reached` | every credit the open took |

A case still open at its deadline is closed as `not_reached` by the deadline sweep (every 15 minutes), whether or not the desk tried (owner ruling 2026-11-17).

**Calling the worker.** Nothing here returns a number. The desk uses the existing reason-gated reveal, `POST /admin/workers/:id/reveal-contact` (capability `reveal_pii`, held by super_admin and support), with the case id as the reason. `worker_id` on the case is the id to reveal.

**The return.** Each credit the open took comes back as a new `returned` lot with a `returned` ledger line naming the open (`unlock_id`): the spent lot's own expiry while that is still ahead (never, for a lot that never expires), else 30 days (`returnedLotValidityDays`) from the close. A free (waived) open returns nothing. Exactly once per spent lot. A `not_reached` close also sets the company's follow-up answer for that open to `not_reached` (#2753, when its switch is on).

## Access

All four routes: `AdminAuthGuard` + `AdminRolesGuard`, capability **`work_reach_desk`** (super_admin, ops_admin, support). `404` while `CREDIT_RULES_ROLLOUT` is off everywhere; `503` with it on and the tables missing.

## `GET /admin/desk/reach-cases`

Query (strict): `status` (`open` default, `resolved`, `all`), `cursor`, `limit` (1–200, default 50). Open cases come nearest deadline first; resolved and all, newest report first.

`200 { cases: Case[], next_cursor }`:

```json
{
  "case_id": "…", "unlock_id": "…", "status": "open",
  "reported_at": "2026-11-17T06:00:00.000Z", "deadline_at": "2026-11-19T06:00:00.000Z",
  "resolved_at": null, "credits_returned": 0,
  "payer_id": "…", "worker_id": "…", "reported_by": "…",
  "resolved_by": null, "resolved_by_admin_id": null, "attempts": 1
}
```

## `GET /admin/desk/reach-cases/:id`

The case plus `attempt_log: [{ attempt_id, admin_id, result, attempted_at }]`. `404` for an unknown id.

## `POST /admin/desk/reach-cases/:id/attempts`

`{ "result": "no_answer" | "busy" | "switched_off" | "wrong_number" | "other" }` (strict; no notes). Answers the case detail. `409 { code: "CASE_RESOLVED" }` on a closed case. Writes an `audit_logs` row (`action = reach_case_attempt_logged`, `entity_type = contact_reach_case`).

## `POST /admin/desk/reach-cases/:id/resolve`

`{ "outcome": "reached_interested" | "reached_declined" | "not_reached", "reason_text": "…" }` (`reason_text` 15–500 characters, no hard identifiers). Answers the case detail. `409 { code: "CASE_RESOLVED" }` on a closed case.

One transaction holds the close, any returned credits, an `audit_logs` row (`action = reach_case_resolved`, with the outcome, the credits returned and the reason) and one `payer.contact_reach_resolved` event (actor = the admin; ids, codes and the count only).
