# Admin credit grants (`POST /admin/payers/:id/credits`)

Issue #2750 item 11 · code: `apps/api/src/admin/admin-actions.*` · switch `CREDIT_RULES_ROLLOUT` (per company) · settings `goodwillMaxPerQuarter` (5), `goodwillValidityDays` (30) in `credit_rules_config`

Capability `grant_credits` (super_admin, ops_admin). The admin is the session's; no body field names one.

## Body

```json
{
  "amount": 2,
  "reason_code": "goodwill",
  "idempotency_key": "6f1c2a3e-4b5d-4e6f-8a7b-9c0d1e2f3a4b",
  "reason_text": "Apology for the failed relay on the 14th",
  "corrects_ledger_id": null
}
```

- `amount`: a positive whole number of credits, at most 10,000.
- `reason_code`: `goodwill`, `correction`, `promo` or `support_resolution` (but see below).
- `idempotency_key`: a uuid. The same key again grants nothing a second time.
- `reason_text`: the staff member's own words, 15–500 characters, no phone numbers or other hard identifiers. Optional outside the credit rules; required under them.
- `corrects_ledger_id`: for a `correction` under the credit rules, the ledger row (this company's) it corrects.

## Outside the credit rules (every company not in the pilot)

As before: any of the four reasons, the ledger line reads `grant`, the lot never expires. The grant now also writes an `audit_logs` row (who granted it, the reason code and any written reason).

## Under the credit rules (a pilot company, or everyone once the switch is `on`)

| Reason | Who | Rule | Ledger line | Lot |
|---|---|---|---|---|
| `goodwill` | super_admin, ops_admin | At most `goodwillMaxPerQuarter` (5) goodwill credits per company per calendar quarter (IST). A grant that would pass it is refused whole. | `goodwill` | expires after `goodwillValidityDays` (30) |
| `correction` | super_admin only | Names the ledger row it corrects (`corrects_ledger_id`, this company's). No cap. | `correction` | never expires |
| `promo`, `support_resolution` | — | Retired: the brief allows no launch offers, and they would walk around the cap. | — | — |

Every grant writes, in one transaction: the lot, the ledger line, an `audit_logs` row (`action = credits_granted`, `entity_type = payer`, metadata `{ledger_id, amount, reason_code, reason_text, corrects_ledger_id, credit_rules}`) and `admin.action_performed` (`credits_granted`, ids only). The staff member is the audit row's actor.

## Errors

| Status | `code` | When |
|---|---|---|
| 400 | `GRANT_REASON_RETIRED` | `promo` or `support_resolution` for a company under the rules |
| 400 | `REASON_TEXT_REQUIRED` | no `reason_text` under the rules |
| 400 | `CORRECTS_LEDGER_ID_REQUIRED` | a `correction` that names no ledger row |
| 400 | — | `corrects_ledger_id` on a goodwill grant |
| 403 | — | a `correction` by anyone but a super admin |
| 404 | — | an unknown company, or a corrected row that is not this company's |
| 409 | `GOODWILL_CAP_EXCEEDED` | the quarter's goodwill would pass the cap; the body has `used` and `cap` |
| 409 | — | a suspended or archived company; or the key was used for another company |
| 503 | — | the pilot list could not be read (which rules apply is unknown) |

A retried request with the same `idempotency_key` after a grant applied is answered as the replay it is (`changed: false`), never refused by the cap the first attempt used up.
