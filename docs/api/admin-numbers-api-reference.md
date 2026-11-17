# Admin API — the numbers screen (`/admin/numbers/*`)

Issue #2755 (part A) · code: `apps/api/src/admin/numbers/*` · switch `ADMIN_NUMBERS_ENABLED` (default off) · capability `read_business_numbers` · no migration of its own

The CEO's weekly numbers screen. Part A ships the foundations: the definitions catalogue and the test-company marks. The weekly figures (`GET /admin/numbers/weekly`, part B), the out-of-credits call list (part C) and the launch-test records (part D) build on the same module.

## Access (every route)

|            |                                                                                            |
| ---------- | ------------------------------------------------------------------------------------------ |
| Auth       | admin session (`AdminAuthGuard`), then `AdminNumbersEnabledGuard`, then `AdminRolesGuard`  |
| Capability | `read_business_numbers` — super_admin, ops_admin (ADR-0025 §3.1; owner question 1 default) |
| Caching    | `Cache-Control: no-store` on every response                                                |

| Caller                                | Answer                                    |
| ------------------------------------- | ----------------------------------------- |
| no admin session                      | `401`                                     |
| `ADMIN_NUMBERS_ENABLED` off, any role | `404` (Nest's bare body; nothing is read) |
| on, support or analyst                | `403`                                     |
| on, super_admin or ops_admin          | the route's answer                        |

`support` is added to the capability only if telecallers sign in as support; `analyst` only on the owner's word. The finance summary (`GET /admin/finance/summary`) stays on `read_entities`.

## `GET /admin/numbers/definitions`

The catalogue as code holds it. Reads no table: every field comes from code, and the payments posture from config.

```ts
{
  definition_version: number; // 1; part B stamps it on every stored row, a rule change bumps it
  week: {
    rule: string; // Monday 00:00 to Sunday 23:59:59 India time, named by its Monday
    time_zone: "Asia/Kolkata";
    utc_offset: "+05:30";
    starts_on: "monday";
  };
  cities: {
    normalisation: string; // lower case, up to the first comma, hyphens as spaces, spaces collapsed
    buckets: string;
    groups: { id: "all" | "ncr" | "pune" | "ahmedabad" | "other" | "unknown"; title: string; members: string[] }[];
  };
  trades: {
    buckets: string;
    groups: {
      id: "all" | "cnc_operator" | "cnc_cam_programmer" | "sheet_metal" | "cad_3d_designer" | "other" | "unknown";
      title: string;
      role_kinds: string[]; // job_postings.role_kind / a form worker's form_kind
      taxonomy_roles: string[]; // worker_occupation.role_id / worker_profiles.canonical_role_id
    }[];
  };
  exclusions: { companies: string; workers: string };
  metric_groups: {
    number: number; // 1..10, brief section 8
    id: string;
    title: string;
    metrics: {
      id: string; // part B's numbers_weekly.metric
      title: string;
      unit: "count" | "paise" | "share" | "ratio";
      source: string;
      rule: string;
      availability:
        | { status: "live" }
        | { status: "not_available"; reason: string; waits_on: "#2749" | "#2750" | "#2751" };
    }[];
  }[];
  small_cell_floor: number; // 5, the onboarding funnel's ADMIN_FUNNEL_K_ANON_FLOOR
  payments: { mode: "real" | "mock"; blocked_reason: string | null }; // the finance PaymentsPosture
}
```

A metric with no live source is `not_available` with its reason and the issue it waits on — never a zero. Live today: paying companies and repeat buying (30/60/90 days), companies that posted, completed profiles, active workers (30 days), confirmed hires, contacts per hire, revenue by pack as charged, and companies out of credits. Waiting: the posting-button shares (#2751), welcome credits, couldn't-reach claims and waivers (#2750), the GST split (#2749 part 3) and Managed Hiring revenue (#2751).

## `PUT /admin/numbers/test-accounts/:payerId`

Mark a company as a test company: it stays out of every company figure. The mark is `payers.is_test_account` (migration 0162), the one company test marker; the rows a test company creates copy it.

|                 |                                                                                                          |
| --------------- | -------------------------------------------------------------------------------------------------------- |
| Path            | `payerId` — a uuid, the company's id as the admin Companies page shows it                                |
| Body (strict)   | `{ reason: "synthetic_sign_in" \| "staff" \| "rehearsal" \| "pilot_test" }`                              |
| Idempotency-Key | REQUIRED header, 8–200 of `A-Z a-z 0-9 . _ : -`; missing or malformed → `400` `idempotency_key_required` |
| Unknown company | `404`                                                                                                    |
| Schema behind   | `503` (the column is missing: fail closed, nothing written)                                              |

Response `200`: `{ payer_id: string; is_test_account: true; changed: boolean }`. `changed: false` means the company was already marked: nothing is written and nothing is emitted (its first reason stands; to change the reason, unmark and mark again). A real change commits the column, `admin.payer_test_account_marked` `{ payer_id, reason, admin_id }` and `admin.action_performed` (`payer_test_account_marked`) in one transaction; the key is part of the marked event's idempotency key.

## `DELETE /admin/numbers/test-accounts/:payerId`

The company counts again. No body. Response `200`: `{ payer_id: string; is_test_account: false; changed: boolean }`; `changed: false` when it was not marked. A real change emits `admin.payer_test_account_unmarked` `{ payer_id, admin_id }` and `admin.action_performed` (`payer_test_account_unmarked`). Unknown company `404`.

## The synthetic-sign-in backfill

`node apps/api/dist/admin/numbers/mark-synthetic-test-payers.cli.js [--apply] [--batch-size=<n>]` (`pnpm --filter @badabhai/api run backfill:synthetic-test-payers`). Dry run by default. It decrypts each unmarked company's sign-in email in process and marks the ones in the reserved `@e2e.badabhai.invalid` domain with reason `synthetic_sign_in` (the same write as the PUT; the event's `admin_id` is null and its actor `system`). It prints payer ids and counts only, never an email. A production write needs `--i-am-authorised-to-write-to-production` and `OPS_ALLOW_PRODUCTION=mark-synthetic-test-payers`.

## Notes on the definitions

### Completed profile (owner question 2)

The rule is the onboarding funnel's `profile_confirmed` step: the worker's current `worker_profiles` row (`CURRENT_PROFILE_ORDER`) is `confirmed`, so the two admin screens cannot disagree. A TRADE-FORM worker reaches it only through the app: finishing the form opens the building screen, which asks for a résumé; with no profile row the Resume cubit's #1371 self-heal calls `POST /profile/extract` (his latest session carries `form_kind`, so the row's `source` is `form`) and then `POST /profile/confirm`. Nothing on the server confirms a profile when a form is completed. A form worker who leaves before the building screen, whose extraction poll times out, or who already has an older unconfirmed chat profile row (the self-heal fires only when there is no row) is not counted, although his answers are saved. Changing the rule would change the funnel and the journey too (`admin-funnel.parity.db.test.ts` pins them together), so the gap is recorded here rather than fixed in the shared rule. Workers with `profile.form_completed` but no confirmed profile measure it.

### Linked RVM identities

A `workers` row the Campus link (#2752) created has `status = 'pending'` and a `worker_origins` row with `kind = 'institute'` (`awaitingFirstSignIn`, `admin-worker-scope.ts`). It is left out of every worker figure until his first worker-app sign-in makes him active. A student who already used BadaBhai keeps his own row and is counted.
