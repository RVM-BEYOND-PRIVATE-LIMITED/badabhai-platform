# Admin API: credit rules settings (`GET` / `PUT /admin/credit-rules`)

Issue #2750 item 1 · code: `apps/api/src/credit-rules/*`, `apps/api/src/admin/credit-rules/*` · shape and defaults: `@badabhai/pricing` `CreditRulesSchema` · migration `0177_credit_rules_config` · switch `CREDIT_RULES_ROLLOUT` (default `off`)

These are the numbers the brief's credit rules use. They can be changed without a deploy. Each edit writes a new revision; old revisions are kept, never rewritten. While no revision exists, the brief's values apply.

## Who may call

|            |                                                                                                    |
| ---------- | -------------------------------------------------------------------------------------------------- |
| Auth       | admin session (`AdminAuthGuard`), then `AdminRolesGuard`                                           |
| Capability | `manage_credit_rules`: super_admin only (new ADR-0025 row; one edit changes every company's price) |

| Caller                                          | Answer                  |
| ----------------------------------------------- | ----------------------- |
| no admin session                                | `401`                   |
| ops_admin, support or analyst                   | `403`                   |
| super_admin, switch `off`                       | `404` (nothing is read) |
| super_admin, switch `pilot`/`on`, table missing | `503`                   |
| super_admin, switch `pilot`/`on`                | `200`                   |

## The rules

The keys keep their stored spelling. The default is the brief's value, and the bounds are enforced on read and on write.

| Key                           | Default | Bounds | Meaning                                                                 |
| ----------------------------- | ------- | ------ | ----------------------------------------------------------------------- |
| `standardCost`                | 1       | 1–10   | Credits to open one contact at the standard cost                        |
| `higherCost`                  | 2       | 1–20   | Credits at the higher cost. Must be at least `standardCost`             |
| `higherCostMinMonths`         | 36      | 1–600  | Months in the higher-priced trade at which the higher cost starts       |
| `welcomeCredits`              | 5       | 0–100  | Given once per verified company, after its first approved post          |
| `welcomeValidityDays`         | 30      | 1–365  | How long the welcome credits last                                       |
| `workerWeeklyOpenLimit`       | 5       | 1–100  | First-time opens of one worker, all companies, in a rolling 7 days      |
| `agencyDailyOpenLimit`        | 40      | 1–1000 | Opens per IST day for an agency or contractor account                   |
| `couldntReachWindowDays`      | 7       | 1–60   | Days after an open in which a couldn't-reach report is accepted         |
| `deskWindowHours`             | 48      | 1–720  | Hours the worker desk has before the credits return                     |
| `returnedCreditsMax`          | 20      | 0–1000 | Most unused credits returned with a new pack                            |
| `returnedCreditsWindowMonths` | 6       | 0–36   | Months after the old pack's expiry in which a new pack brings them back |
| `returnedLotValidityDays`     | 30      | 1–365  | Validity of a credit returned after its lot expired                     |
| `refundUnusedWithinDays`      | 7       | 0–90   | Refund rule 1: an unused pack within this many days of purchase         |
| `refundLowMatchWithinDays`    | 30      | 0–90   | Refund rule 2: an unused pack within this many days, ...                |
| `refundLowMatchMinWorkers`    | 3       | 1–100  | ... if its job drew fewer than this many matching workers               |
| `goodwillMaxPerQuarter`       | 5       | 0–1000 | Most goodwill credits per company per IST calendar quarter              |
| `goodwillValidityDays`        | 30      | 1–365  | How long goodwill credits last                                          |

In this part, only the settings themselves are live. Each rule starts taking effect as its own part of #2750 lands.

## `GET /admin/credit-rules`

```ts
{
  rules: CreditRules; // the active values
  defaults: CreditRules; // the brief's values
  revision: number; // 0 before the first edit; send it back as expected_revision
  source: "db" | "default"; // "default": no revision yet, or the stored one failed validation
  updated_at: string | null; // ISO time the active revision was written
}
```

The read is fresh, never cached, so the revision shown is the one an edit will be checked against.

## `PUT /admin/credit-rules`

```ts
// body (strict: any other key is 400)
{
  rules: CreditRules;        // EVERY key. A partial set is 400; a missing key is never reset to its default
  expected_revision: number; // the revision you loaded
  reason_text: string;       // 15–500 characters, no email, phone or other hard identifier
}
// 200
{ ...GET response, changed: boolean, changed_keys: string[] }
```

| Case                                                                                    | Answer                                      |
| --------------------------------------------------------------------------------------- | ------------------------------------------- |
| a value outside its bounds, `higherCost` below `standardCost`, a missing or unknown key | `400`                                       |
| `expected_revision` is not the newest revision (someone saved first)                    | `409`; nothing is written                   |
| two saves of the same revision at once                                                  | one `200`, the other `409`                  |
| no value differs from the active revision                                               | `200`, `changed: false`; nothing is written |

One transaction holds three writes: the new revision, an `audit_logs` row (`action = credit_rules_changed`, `entity_type = credit_rules_config`, with the admin, the changed keys, their old and new values and the reason), and one `admin.action_performed` (`action_code = credit_rules_changed`, `target_type = credit_rules_config`). The event carries no values. The process that served the edit shows the new values at once; other processes show them within 30 seconds.
